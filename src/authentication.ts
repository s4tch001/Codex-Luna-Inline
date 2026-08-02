import * as vscode from "vscode";

import { readConfiguration } from "./config.js";
import { CodexCli } from "./codexCli.js";
import { ProcessCancelledError } from "./processRunner.js";
import type { AuthenticationStatus } from "./types.js";

const STATUS_CACHE_MS = 2 * 60_000;

interface CachedStatus {
  readonly value: AuthenticationStatus;
  readonly expiresAt: number;
}

interface AccountAction extends vscode.QuickPickItem {
  readonly action: "sign-in" | "switch" | "sign-out" | "status";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AuthenticationManager implements vscode.Disposable {
  private readonly statusEmitter = new vscode.EventEmitter<AuthenticationStatus>();
  private cachedStatus: CachedStatus | undefined;

  public readonly onDidChangeStatus = this.statusEmitter.event;

  public constructor(
    private readonly cli: CodexCli,
    private readonly output: vscode.OutputChannel
  ) {}

  public dispose(): void {
    this.statusEmitter.dispose();
  }

  public invalidate(): void {
    this.cachedStatus = undefined;
  }

  public async status(force = false): Promise<AuthenticationStatus> {
    if (!force && this.cachedStatus !== undefined && this.cachedStatus.expiresAt > Date.now()) {
      return this.cachedStatus.value;
    }

    const status = await this.cli.authenticationStatus(readConfiguration());
    this.cachedStatus = { value: status, expiresAt: Date.now() + STATUS_CACHE_MS };
    this.statusEmitter.fire(status);
    return status;
  }

  public async hasChatGptLogin(): Promise<boolean> {
    return (await this.status()).kind === "chatgpt";
  }

  public async signIn(): Promise<void> {
    this.invalidate();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Codex Luna Inline: Sign in to ChatGPT in your browser",
          cancellable: true
        },
        async (_progress, token) => {
          await this.cli.login(readConfiguration(), token, (chunk) => this.output.append(chunk));
        }
      );
    } catch (error) {
      if (error instanceof ProcessCancelledError) {
        return;
      }
      this.output.appendLine(`[auth] Login failed: ${errorMessage(error)}`);
      await this.showCliError(error);
      return;
    }

    const status = await this.status(true);
    if (status.kind === "chatgpt") {
      await vscode.window.showInformationMessage("Codex CLI is signed in with a ChatGPT account.");
      return;
    }

    await vscode.window.showErrorMessage(
      "Login finished, but the ChatGPT account could not be verified. Run “Codex Luna Inline: Check Login Status”."
    );
  }

  public async switchAccount(): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      "This will sign out the current Codex account and open a new ChatGPT browser login.",
      { modal: true },
      "Switch account"
    );
    if (confirmation !== "Switch account") {
      return;
    }

    try {
      await this.cli.logout(readConfiguration());
      this.invalidate();
      await this.signIn();
    } catch (error) {
      this.output.appendLine(`[auth] Account switch failed: ${errorMessage(error)}`);
      await this.showCliError(error);
    }
  }

  public async signOut(): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      "Remove the saved Codex CLI login from this machine?",
      { modal: true },
      "Sign out"
    );
    if (confirmation !== "Sign out") {
      return;
    }

    try {
      await this.cli.logout(readConfiguration());
      this.invalidate();
      await this.status(true);
      await vscode.window.showInformationMessage("Codex CLI has been signed out.");
    } catch (error) {
      this.output.appendLine(`[auth] Logout failed: ${errorMessage(error)}`);
      await this.showCliError(error);
    }
  }

  public async showStatus(): Promise<void> {
    const status = await this.status(true);
    const prefix = status.kind === "chatgpt" ? "Ready" : "Not ready";
    await vscode.window.showInformationMessage(`${prefix}: ${status.detail}`);
  }

  public async showAccountMenu(): Promise<void> {
    const status = await this.status(true);
    const signedIn = status.kind === "chatgpt";
    const hasDifferentAuthentication = status.kind === "api-key"
      || status.kind === "access-token"
      || status.kind === "unknown-auth";
    const items: AccountAction[] = signedIn
      ? [
          {
            label: "$(check) Use the current ChatGPT account",
            description: status.detail,
            action: "status"
          },
          {
            label: "$(account) Switch ChatGPT account",
            description: "Sign out, then choose an account in the browser login",
            action: "switch"
          },
          {
            label: "$(sign-out) Sign out",
            action: "sign-out"
          }
        ]
      : [
          {
            label: hasDifferentAuthentication
              ? "$(account) Switch to a ChatGPT account"
              : "$(account) Sign in with ChatGPT",
            description: hasDifferentAuthentication
              ? "Remove the current non-ChatGPT auth before browser login"
              : "Use your ChatGPT plan; no API key",
            action: hasDifferentAuthentication ? "switch" : "sign-in"
          },
          {
            label: "$(refresh) Check login status again",
            description: status.detail,
            action: "status"
          }
        ];

    const selection = await vscode.window.showQuickPick(items, {
      title: "Codex Luna Inline — ChatGPT account",
      placeHolder: "Choose an account action"
    });
    if (selection === undefined) {
      return;
    }

    switch (selection.action) {
      case "sign-in":
        await this.signIn();
        break;
      case "switch":
        await this.switchAccount();
        break;
      case "sign-out":
        await this.signOut();
        break;
      case "status":
        await this.showStatus();
        break;
      default: {
        const unreachable: never = selection.action;
        throw new Error(`Unknown account action: ${String(unreachable)}`);
      }
    }
  }

  private async showCliError(error: unknown): Promise<void> {
    const action = await vscode.window.showErrorMessage(
      `Codex CLI is unavailable: ${errorMessage(error)}`,
      "Copy install command",
      "Show log"
    );
    if (action === "Copy install command") {
      await vscode.env.clipboard.writeText("npm install -g @openai/codex");
      await vscode.window.showInformationMessage("Copied: npm install -g @openai/codex");
    } else if (action === "Show log") {
      this.output.show(true);
    }
  }
}
