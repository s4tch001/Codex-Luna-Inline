import { mkdir } from "node:fs/promises";

import * as vscode from "vscode";

import { AuthenticationManager } from "./authentication.js";
import { CodexCli } from "./codexCli.js";
import { affectsConfiguration, readConfiguration, setEnabled } from "./config.js";
import { RecentEditTracker } from "./contextBuilder.js";
import { CodexInlineCompletionProvider } from "./inlineProvider.js";
import { ProcessRunner } from "./processRunner.js";
import type { AuthenticationStatus } from "./types.js";

interface UiState {
  auth: AuthenticationStatus;
  busy: boolean;
}

function initialStatus(): AuthenticationStatus {
  return { kind: "signed-out", detail: "Checking Codex login…" };
}

function registerCommand(
  context: vscode.ExtensionContext,
  command: string,
  callback: () => void | Promise<void>
): void {
  context.subscriptions.push(vscode.commands.registerCommand(command, callback));
}

function renderStatusBar(statusBar: vscode.StatusBarItem, state: UiState): void {
  let enabled = false;
  try {
    enabled = readConfiguration().enabled;
  } catch (error) {
    statusBar.text = "$(error) Codex config";
    statusBar.tooltip = error instanceof Error ? error.message : String(error);
    statusBar.show();
    return;
  }

  if (!enabled) {
    statusBar.text = "$(circle-slash) Codex Luna";
    statusBar.tooltip = "Automatic inline completions are disabled.";
  } else if (state.busy) {
    statusBar.text = "$(loading~spin) Codex Luna";
    statusBar.tooltip = "Generating an inline completion with GPT-5.6 Luna…";
  } else {
    switch (state.auth.kind) {
      case "chatgpt":
        statusBar.text = "$(sparkle) Codex Luna";
        statusBar.tooltip = `Ready — ${state.auth.detail}`;
        break;
      case "api-key":
        statusBar.text = "$(warning) Codex API blocked";
        statusBar.tooltip = "API-key login is blocked by this extension. Select a ChatGPT account instead.";
        break;
      case "access-token":
        statusBar.text = "$(warning) Codex token blocked";
        statusBar.tooltip = "Access-token login is blocked. Select a ChatGPT account instead.";
        break;
      case "unknown-auth":
        statusBar.text = "$(question) Codex login";
        statusBar.tooltip = state.auth.detail;
        break;
      case "signed-out":
        statusBar.text = "$(account) Codex sign in";
        statusBar.tooltip = state.auth.detail;
        break;
      case "unavailable":
        statusBar.text = "$(error) Codex CLI";
        statusBar.tooltip = state.auth.detail;
        break;
      default: {
        const unreachable: never = state.auth;
        throw new Error(`Unknown authentication state: ${String(unreachable)}`);
      }
    }
  }

  statusBar.show();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Codex Luna Inline", { log: true });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.name = "Codex Luna Inline";
  statusBar.command = "codexLunaInline.account";
  context.subscriptions.push(output, statusBar);

  await mkdir(context.globalStorageUri.fsPath, { recursive: true });
  const cli = new CodexCli(new ProcessRunner(), context.globalStorageUri.fsPath, output);
  const authentication = new AuthenticationManager(cli, output);
  const recentEdits = new RecentEditTracker();
  const provider = new CodexInlineCompletionProvider(cli, authentication, recentEdits, output);
  context.subscriptions.push(cli, authentication, recentEdits, provider);

  const state: UiState = { auth: initialStatus(), busy: false };
  renderStatusBar(statusBar, state);

  const warmCompletionServer = (): void => {
    try {
      const configuration = readConfiguration();
      if (state.auth.kind === "chatgpt" && configuration.enabled) {
        void cli.warmup(configuration);
      }
    } catch (error) {
      output.appendLine(`[config] ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  context.subscriptions.push(
    authentication.onDidChangeStatus((status) => {
      state.auth = status;
      renderStatusBar(statusBar, state);
      warmCompletionServer();
    }),
    provider.onDidChangeBusy((busy) => {
      state.busy = busy;
      renderStatusBar(statusBar, state);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsConfiguration(event)) {
        authentication.invalidate();
        cli.resetCompletionServer();
        renderStatusBar(statusBar, state);
        warmCompletionServer();
      }
    }),
    vscode.languages.registerInlineCompletionItemProvider(
      [
        { scheme: "file" },
        { scheme: "untitled" },
        { scheme: "vscode-remote" }
      ],
      provider
    )
  );

  registerCommand(context, "codexLunaInline.toggle", async () => {
    const enabled = !readConfiguration().enabled;
    await setEnabled(enabled);
    renderStatusBar(statusBar, state);
    await vscode.window.showInformationMessage(
      `Codex Luna automatic completions: ${enabled ? "ON" : "OFF"}.`
    );
  });
  registerCommand(context, "codexLunaInline.trigger", async () => {
    if (!readConfiguration().enabled) {
      await vscode.window.showInformationMessage("Codex Luna automatic completions are turned off.");
      return;
    }
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
  });
  registerCommand(context, "codexLunaInline.account", () => authentication.showAccountMenu());
  registerCommand(context, "codexLunaInline.signIn", () => authentication.signIn());
  registerCommand(context, "codexLunaInline.switchAccount", () => authentication.switchAccount());
  registerCommand(context, "codexLunaInline.signOut", () => authentication.signOut());
  registerCommand(context, "codexLunaInline.showStatus", () => authentication.showStatus());
  registerCommand(context, "codexLunaInline.showOutput", () => output.show(true));

  output.appendLine("Codex Luna Inline activated. No OpenAI API key or API endpoint is used.");
  const authStatus = await authentication.status(true);
  if (authStatus.kind !== "chatgpt") {
    const onboardingShown = context.globalState.get<boolean>("onboardingShown", false);
    if (!onboardingShown) {
      await context.globalState.update("onboardingShown", true);
      const action = await vscode.window.showInformationMessage(
        "Codex Luna Inline needs a ChatGPT-authenticated Codex CLI. No API key is used.",
        "Choose / sign in to an account",
        "Later"
      );
      if (action === "Choose / sign in to an account") {
        await authentication.showAccountMenu();
      }
    }
  }
}

export function deactivate(): void {
  // VS Code disposes all subscriptions registered by activate.
}
