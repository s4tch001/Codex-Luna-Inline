import * as vscode from "vscode";

import {
  asCliExecutable,
  asModelId,
  isReasoningEffort,
  type ExtensionConfiguration,
  type ReasoningEffort
} from "./types.js";

const SECTION = "codexLunaInline";

const DEFAULT_EXCLUSIONS = [
  "**/.env",
  "**/.env.*",
  "**/*secret*",
  "**/*credentials*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/.npmrc",
  "**/.pypirc"
] as const;

function numberSetting(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = configuration.get<number>(key, fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function readConfiguration(): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const rawEffort = configuration.get<string>("reasoningEffort", "low");
  const reasoningEffort: ReasoningEffort = isReasoningEffort(rawEffort) ? rawEffort : "low";
  const excludedFiles = configuration
    .get<readonly string[]>("excludedFiles", DEFAULT_EXCLUSIONS)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return {
    enabled: configuration.get<boolean>("enabled", true),
    codexPath: asCliExecutable(configuration.get<string>("codexPath", "codex")),
    model: asModelId(configuration.get<string>("model", "gpt-5.6-luna")),
    reasoningEffort,
    debounceMs: numberSetting(configuration, "debounceMs", 250, 100, 5_000),
    timeoutMs: numberSetting(configuration, "timeoutMs", 20_000, 5_000, 120_000),
    maxPrefixChars: numberSetting(configuration, "maxPrefixChars", 30_000, 1_000, 80_000),
    maxSuffixChars: numberSetting(configuration, "maxSuffixChars", 15_000, 0, 50_000),
    maxWholeFileChars: numberSetting(configuration, "maxWholeFileChars", 80_000, 5_000, 250_000),
    maxSuggestionLines: numberSetting(configuration, "maxSuggestionLines", 12, 1, 50),
    usePersistentServer: configuration.get<boolean>("usePersistentServer", true),
    excludedFiles
  } satisfies ExtensionConfiguration;
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update("enabled", enabled, vscode.ConfigurationTarget.Global);
}

export function affectsConfiguration(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}
