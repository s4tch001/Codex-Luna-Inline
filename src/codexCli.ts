import type * as vscode from "vscode";

import { AppServerStartupError, CodexAppServer } from "./codexAppServer.js";
import {
  buildCompletionPrompt,
  buildLegacyCompletionPrompt,
  classifyAuthentication,
  sanitizeCompletion
} from "./pure.js";
import { ProcessCancelledError, ProcessRunner } from "./processRunner.js";
import type {
  AuthenticationStatus,
  ExtensionConfiguration,
  ProcessResult,
  SourceContext
} from "./types.js";

export class CodexCliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodexCliError";
  }
}

function combinedOutput(result: ProcessResult): string {
  return [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join("\n").trim();
}

function conciseFailure(result: ProcessResult): string {
  const output = combinedOutput(result);
  if (output.length === 0) {
    return `Codex CLI exited with code ${String(result.exitCode)}.`;
  }

  return output.length > 1_000 ? `${output.slice(0, 1_000)}…` : output;
}

function unavailableStatus(error: unknown): AuthenticationStatus {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "unavailable",
    detail: `Codex CLI cannot be run: ${message}`
  };
}

export class CodexCli implements vscode.Disposable {
  private readonly appServer: CodexAppServer;

  public constructor(
    private readonly runner: ProcessRunner,
    private readonly executionCwd: string,
    private readonly output: vscode.OutputChannel
  ) {
    this.appServer = new CodexAppServer(executionCwd, output);
  }

  public dispose(): void {
    this.appServer.dispose();
  }

  public async warmup(configuration: ExtensionConfiguration): Promise<void> {
    try {
      await this.appServer.warmup(configuration);
    } catch (error) {
      this.output.appendLine(`[app-server] Warmup unavailable; codex exec fallback remains active: ${errorMessage(error)}`);
    }
  }

  public resetCompletionServer(): void {
    this.appServer.stop();
  }

  public async authenticationStatus(
    configuration: ExtensionConfiguration,
    token?: vscode.CancellationToken
  ): Promise<AuthenticationStatus> {
    try {
      const options = {
        cwd: this.executionCwd,
        timeoutMs: Math.min(configuration.timeoutMs, 15_000),
        ...(token === undefined ? {} : { token })
      };
      const result = await this.runner.run(configuration.codexPath, ["login", "status"], options);
      return classifyAuthentication(result.exitCode, combinedOutput(result));
    } catch (error) {
      if (error instanceof ProcessCancelledError) {
        throw error;
      }
      return unavailableStatus(error);
    }
  }

  public async login(
    configuration: ExtensionConfiguration,
    token: vscode.CancellationToken,
    onOutput: (chunk: string) => void
  ): Promise<void> {
    this.resetCompletionServer();
    this.output.appendLine("[auth] Starting ChatGPT browser login through Codex CLI.");
    const result = await this.runner.run(configuration.codexPath, ["login"], {
      cwd: this.executionCwd,
      timeoutMs: 5 * 60_000,
      token,
      onOutput
    });
    if (result.exitCode !== 0) {
      throw new CodexCliError(conciseFailure(result));
    }
  }

  public async logout(configuration: ExtensionConfiguration): Promise<void> {
    this.resetCompletionServer();
    this.output.appendLine("[auth] Removing the current Codex CLI login.");
    const result = await this.runner.run(configuration.codexPath, ["logout"], {
      cwd: this.executionCwd,
      timeoutMs: 15_000
    });
    if (result.exitCode !== 0) {
      throw new CodexCliError(conciseFailure(result));
    }
  }

  public async complete(
    sourceContext: SourceContext,
    configuration: ExtensionConfiguration,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    const prompt = buildCompletionPrompt(sourceContext);
    if (configuration.usePersistentServer) {
      const startedAt = Date.now();
      try {
        const response = await this.appServer.complete(prompt, configuration, token);
        this.output.appendLine(
          `[completion] Persistent Luna turn finished in ${Date.now() - startedAt} ms.`
        );
        return sanitizeCompletion(
          response,
          sourceContext.prefix,
          sourceContext.suffix,
          configuration.maxSuggestionLines
        );
      } catch (error) {
        if (!(error instanceof AppServerStartupError)) {
          throw error;
        }
        this.output.appendLine(`[app-server] Falling back to codex exec: ${error.message}`);
      }
    }

    const args = [
      "exec",
      "--model",
      configuration.model,
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--ignore-user-config",
      "--color",
      "never",
      "-c",
      "approval_policy='never'",
      "-c",
      `model_reasoning_effort='${configuration.reasoningEffort}'`,
      "-"
    ] as const;

    this.output.appendLine(
      `[completion] Requesting ${String(configuration.model)} (${configuration.reasoningEffort}) for ${sourceContext.languageId}.`
    );
    const startedAt = Date.now();
    const result = await this.runner.run(configuration.codexPath, args, {
      cwd: this.executionCwd,
      timeoutMs: configuration.timeoutMs,
      stdin: buildLegacyCompletionPrompt(sourceContext),
      token
    });

    this.output.appendLine(`[completion] Codex finished in ${Date.now() - startedAt} ms (exit ${String(result.exitCode)}).`);
    if (result.exitCode !== 0) {
      throw new CodexCliError(conciseFailure(result));
    }

    return sanitizeCompletion(
      result.stdout,
      sourceContext.prefix,
      sourceContext.suffix,
      configuration.maxSuggestionLines
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
