import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import type { CliExecutable, ProcessResult } from "./types.js";

const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;

export class ProcessCancelledError extends Error {
  public constructor() {
    super("The Codex process was cancelled.");
    this.name = "ProcessCancelledError";
  }
}

export class ProcessTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`The Codex process exceeded the ${timeoutMs} ms timeout.`);
    this.name = "ProcessTimeoutError";
  }
}

export interface RunProcessOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdin?: string;
  readonly token?: vscode.CancellationToken;
  readonly onOutput?: (chunk: string) => void;
}

interface SpawnSpecification {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(executable: CliExecutable): Promise<string> {
  const raw = String(executable);
  if (path.isAbsolute(raw) || raw.includes("/") || raw.includes("\\")) {
    return raw;
  }

  const searchPath = process.env.PATH ?? process.env.Path ?? "";
  const directories = searchPath.split(path.delimiter).filter((entry) => entry.length > 0);
  const extensions = process.platform === "win32" && path.extname(raw).length === 0
    ? [".exe", ".com", ".cmd", ".bat", ""]
    : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/gu, ""), `${raw}${extension}`);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return raw;
}

function quoteCmdArgument(argument: string): string {
  return `"${argument.replaceAll("%", "%%").replaceAll("\"", "\"\"")}"`;
}

function toSpawnSpecification(executable: string, args: readonly string[]): SpawnSpecification {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(executable)) {
    const commandProcessor = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    const commandLine = [executable, ...args].map(quoteCmdArgument).join(" ");
    return {
      command: commandProcessor,
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true
    };
  }

  return { command: executable, args, windowsVerbatimArguments: false };
}

function codexEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (normalized === "OPENAI_API_KEY" || normalized === "CODEX_API_KEY" || normalized === "CODEX_ACCESS_TOKEN") {
      delete environment[key];
    }
  }

  return environment;
}

export async function spawnManagedProcess(
  executable: CliExecutable,
  args: readonly string[],
  cwd: string
): Promise<ChildProcessWithoutNullStreams> {
  const resolvedExecutable = await resolveExecutable(executable);
  const specification = toSpawnSpecification(resolvedExecutable, args);
  return spawn(specification.command, specification.args, {
    cwd,
    env: codexEnvironment(),
    shell: false,
    windowsVerbatimArguments: specification.windowsVerbatimArguments,
    windowsHide: true,
    stdio: "pipe"
  });
}

export class ProcessRunner {
  public async run(
    executable: CliExecutable,
    args: readonly string[],
    options: RunProcessOptions
  ): Promise<ProcessResult> {
    if (options.token?.isCancellationRequested === true) {
      throw new ProcessCancelledError();
    }

    const child = await spawnManagedProcess(executable, args, options.cwd);

    return new Promise<ProcessResult>((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";

      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        cancellation?.dispose();
        action();
      };

      const failAndKill = (error: Error): void => {
        child.kill();
        finish(() => reject(error));
      };

      const timeout = setTimeout(() => {
        failAndKill(new ProcessTimeoutError(options.timeoutMs));
      }, options.timeoutMs);

      const cancellation = options.token?.onCancellationRequested(() => {
        failAndKill(new ProcessCancelledError());
      });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        options.onOutput?.(chunk);
        if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_CAPTURED_OUTPUT_BYTES) {
          failAndKill(new Error("Codex produced too much output."));
        }
      });

      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        options.onOutput?.(chunk);
        if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_CAPTURED_OUTPUT_BYTES) {
          failAndKill(new Error("Codex produced too much output."));
        }
      });

      child.on("error", (error) => {
        finish(() => reject(error));
      });

      child.on("close", (exitCode, signal) => {
        finish(() => resolve({ exitCode, signal, stdout, stderr }));
      });

      child.stdin.on("error", () => {
        // The process may close stdin before Node finishes writing during cancellation.
      });
      child.stdin.end(options.stdin ?? "");
    });
  }
}
