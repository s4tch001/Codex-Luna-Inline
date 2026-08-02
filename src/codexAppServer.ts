import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

import type * as vscode from "vscode";

import {
  completedAgentMessage,
  completedTurn,
  parseRpcMessage,
  threadIdFromStartResult,
  turnIdFromStartResult,
  type CompletedTurn,
  type JsonObject,
  type JsonValue
} from "./appServerProtocol.js";
import { COMPLETION_BASE_INSTRUCTIONS } from "./pure.js";
import {
  ProcessCancelledError,
  ProcessTimeoutError,
  spawnManagedProcess
} from "./processRunner.js";
import type { CliExecutable, ExtensionConfiguration } from "./types.js";

const RPC_TIMEOUT_MS = 15_000;

const COMPLETION_FEATURES = {
  apps: false,
  auth_elicitation: false,
  browser_use: false,
  code_mode_host: false,
  computer_use: false,
  goals: false,
  hooks: false,
  image_generation: false,
  in_app_browser: false,
  multi_agent: false,
  plugins: false,
  shell_snapshot: false,
  shell_tool: false,
  skill_search: false,
  tool_suggest: false,
  workspace_dependencies: false
} as const;

const APP_SERVER_ARGS = [
  "app-server",
  "--stdio",
  "-c",
  "mcp_servers={}",
  ...Object.entries(COMPLETION_FEATURES).flatMap(([feature, enabled]) => [
    "-c",
    `features.${feature}=${String(enabled)}`
  ])
] as const;

const COMPLETION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    completion: { type: "string" }
  },
  required: ["completion"],
  additionalProperties: false
} as const;

interface PendingRequest {
  readonly resolve: (result: JsonValue) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface EarlyTurnState {
  readonly message: string;
  readonly completion: CompletedTurn | undefined;
}

interface ActiveTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly resolve: (message: string) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
  readonly cancellation: vscode.Disposable;
  message: string;
  settled: boolean;
}

export class AppServerStartupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AppServerStartupError";
  }
}

export class AppServerTurnError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AppServerTurnError";
  }
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CodexAppServer implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private reader: readline.Interface | undefined;
  private startPromise: Promise<void> | undefined;
  private executable: CliExecutable | undefined;
  private ready = false;
  private expectedStop = false;
  private disposed = false;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly earlyTurns = new Map<string, EarlyTurnState>();

  public constructor(
    private readonly cwd: string,
    private readonly output: vscode.OutputChannel
  ) {}

  public async warmup(configuration: ExtensionConfiguration): Promise<void> {
    if (!configuration.usePersistentServer) {
      return;
    }
    await this.ensureStarted(configuration.codexPath);
  }

  public async complete(
    prompt: string,
    configuration: ExtensionConfiguration,
    token: vscode.CancellationToken
  ): Promise<string> {
    if (token.isCancellationRequested) {
      throw new ProcessCancelledError();
    }
    await this.ensureStarted(configuration.codexPath);

    const threadResult = await this.request("thread/start", {
      model: String(configuration.model),
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      personality: "none",
      ephemeral: true,
      serviceName: "codex_luna_inline",
      baseInstructions: COMPLETION_BASE_INSTRUCTIONS,
      developerInstructions: "",
      config: {
        mcp_servers: {},
        features: COMPLETION_FEATURES,
        model_reasoning_effort: configuration.reasoningEffort,
        reasoning_summary: "none"
      }
    });
    const threadId = threadIdFromStartResult(threadResult);
    if (threadId === undefined) {
      throw new AppServerStartupError("Codex app-server returned no thread id.");
    }
    if (token.isCancellationRequested) {
      void this.unsubscribe(threadId);
      throw new ProcessCancelledError();
    }

    const turnResult = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd: this.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: String(configuration.model),
      effort: configuration.reasoningEffort,
      summary: "none",
      personality: "none",
      outputSchema: COMPLETION_OUTPUT_SCHEMA
    });
    const turnId = turnIdFromStartResult(turnResult);
    if (turnId === undefined) {
      void this.unsubscribe(threadId);
      throw new AppServerTurnError("Codex app-server returned no turn id.");
    }

    return this.waitForTurn(threadId, turnId, configuration.timeoutMs, token);
  }

  public stop(): void {
    this.expectedStop = true;
    this.ready = false;
    this.startPromise = undefined;
    this.reader?.close();
    this.reader = undefined;
    this.child?.kill();
    this.child = undefined;
    this.executable = undefined;
    this.failAll(new AppServerStartupError("Codex app-server stopped."));
  }

  public dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private async ensureStarted(executable: CliExecutable): Promise<void> {
    if (this.disposed) {
      throw new AppServerStartupError("Codex app-server client is disposed.");
    }
    if (this.ready && this.executable === executable) {
      return;
    }
    if (this.executable !== undefined && this.executable !== executable) {
      this.stop();
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal(executable);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startInternal(executable: CliExecutable): Promise<void> {
    this.expectedStop = false;
    this.output.appendLine("[app-server] Starting persistent Codex completion server.");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await spawnManagedProcess(
        executable,
        APP_SERVER_ARGS,
        this.cwd
      );
    } catch (error) {
      throw new AppServerStartupError(errorMessage(error));
    }

    this.child = child;
    this.executable = executable;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed.length > 0) {
        this.output.appendLine(`[app-server] ${trimmed}`);
      }
    });
    child.on("error", (error) => this.handleExit(child, error));
    child.on("close", (code) => {
      this.handleExit(child, new AppServerStartupError(`Codex app-server exited with code ${String(code)}.`));
    });

    try {
      await this.requestRaw("initialize", {
        clientInfo: {
          name: "codex_luna_inline",
          title: "Codex Luna Inline",
          version: "0.2.0"
        },
        capabilities: {
          optOutNotificationMethods: [
            "item/agentMessage/delta",
            "item/reasoning/summaryTextDelta",
            "item/reasoning/summaryPartAdded",
            "item/reasoning/textDelta",
            "thread/tokenUsage/updated"
          ]
        }
      }, RPC_TIMEOUT_MS);
      this.sendNotification("initialized", {});
      this.ready = true;
      this.output.appendLine("[app-server] Ready; future completions reuse this process.");
    } catch (error) {
      this.stop();
      throw new AppServerStartupError(errorMessage(error));
    }
  }

  private request(method: string, params: JsonObject, timeoutMs = RPC_TIMEOUT_MS): Promise<JsonValue> {
    if (!this.ready) {
      return Promise.reject(new AppServerStartupError("Codex app-server is not initialized."));
    }
    return this.requestRaw(method, params, timeoutMs);
  }

  private requestRaw(method: string, params: JsonObject, timeoutMs: number): Promise<JsonValue> {
    const child = this.child;
    if (child === undefined || child.stdin.destroyed) {
      return Promise.reject(new AppServerStartupError("Codex app-server stdin is unavailable."));
    }
    const id = ++this.requestId;
    return new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProcessTimeoutError(timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (error !== null && error !== undefined) {
          const pending = this.pending.get(id);
          if (pending !== undefined) {
            clearTimeout(pending.timeout);
            this.pending.delete(id);
            pending.reject(new AppServerStartupError(error.message));
          }
        }
      });
    });
  }

  private sendNotification(method: string, params: JsonObject): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    const message = parseRpcMessage(line);
    if (message === undefined) {
      this.output.appendLine("[app-server] Ignored an invalid protocol line.");
      return;
    }
    if (message.kind === "response" || message.kind === "error") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.kind === "response") {
        pending.resolve(message.result);
      } else {
        pending.reject(new AppServerTurnError(`${message.error.message} (RPC ${message.error.code})`));
      }
      return;
    }

    if (message.method === "item/completed") {
      const agentMessage = completedAgentMessage(message.params);
      if (agentMessage !== undefined) {
        const key = turnKey(agentMessage.threadId, agentMessage.turnId);
        const active = this.activeTurns.get(key);
        if (active !== undefined) {
          active.message = agentMessage.text;
        } else {
          const early = this.earlyTurns.get(key);
          this.earlyTurns.set(key, {
            message: agentMessage.text,
            completion: early?.completion
          });
        }
      }
      return;
    }

    if (message.method === "turn/completed") {
      const completion = completedTurn(message.params);
      if (completion !== undefined) {
        const key = turnKey(completion.threadId, completion.turnId);
        const active = this.activeTurns.get(key);
        if (active !== undefined) {
          this.finishTurn(active, completion);
        } else {
          const early = this.earlyTurns.get(key);
          this.earlyTurns.set(key, {
            message: early?.message ?? "",
            completion
          });
        }
      }
    }
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
    timeoutMs: number,
    token: vscode.CancellationToken
  ): Promise<string> {
    const key = turnKey(threadId, turnId);
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const active = this.activeTurns.get(key);
        if (active !== undefined) {
          void this.interrupt(active);
          this.rejectTurn(active, new ProcessTimeoutError(timeoutMs));
        }
      }, timeoutMs);
      const cancellation = token.onCancellationRequested(() => {
        const active = this.activeTurns.get(key);
        if (active !== undefined) {
          void this.interrupt(active);
          this.rejectTurn(active, new ProcessCancelledError());
        }
      });
      const active: ActiveTurn = {
        threadId,
        turnId,
        resolve,
        reject,
        timeout,
        cancellation,
        message: "",
        settled: false
      };
      this.activeTurns.set(key, active);

      const early = this.earlyTurns.get(key);
      if (early !== undefined) {
        active.message = early.message;
        this.earlyTurns.delete(key);
        if (early.completion !== undefined) {
          this.finishTurn(active, early.completion);
        }
      } else if (token.isCancellationRequested) {
        void this.interrupt(active);
        this.rejectTurn(active, new ProcessCancelledError());
      }
    });
  }

  private finishTurn(active: ActiveTurn, completion: CompletedTurn): void {
    if (completion.status === "completed" && active.message.length > 0) {
      this.settleTurn(active, () => active.resolve(active.message));
      return;
    }
    if (completion.status === "interrupted") {
      this.rejectTurn(active, new ProcessCancelledError());
      return;
    }
    this.rejectTurn(
      active,
      new AppServerTurnError(completion.errorMessage ?? `Codex turn ended with status ${completion.status}.`)
    );
  }

  private rejectTurn(active: ActiveTurn, error: Error): void {
    this.settleTurn(active, () => active.reject(error));
  }

  private settleTurn(active: ActiveTurn, settle: () => void): void {
    if (active.settled) {
      return;
    }
    active.settled = true;
    clearTimeout(active.timeout);
    active.cancellation.dispose();
    this.activeTurns.delete(turnKey(active.threadId, active.turnId));
    void this.unsubscribe(active.threadId);
    settle();
  }

  private async interrupt(active: ActiveTurn): Promise<void> {
    try {
      await this.request("turn/interrupt", {
        threadId: active.threadId,
        turnId: active.turnId
      }, 5_000);
    } catch {
      // Cancellation remains successful for the editor even if the process already ended.
    }
  }

  private async unsubscribe(threadId: string): Promise<void> {
    try {
      await this.request("thread/unsubscribe", { threadId }, 5_000);
    } catch {
      // The server will release ephemeral state when the process exits.
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) {
      return;
    }
    this.ready = false;
    this.child = undefined;
    this.reader?.close();
    this.reader = undefined;
    if (!this.expectedStop) {
      this.output.appendLine(`[app-server] ${error.message}`);
    }
    this.failAll(error);
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
    for (const turn of this.activeTurns.values()) {
      clearTimeout(turn.timeout);
      turn.cancellation.dispose();
      turn.reject(error);
    }
    this.activeTurns.clear();
    this.earlyTurns.clear();
  }
}
