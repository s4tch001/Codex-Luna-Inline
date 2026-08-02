export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type CliExecutable = Brand<string, "CliExecutable">;
export type ModelId = Brand<string, "ModelId">;

export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ExtensionConfiguration {
  readonly enabled: boolean;
  readonly codexPath: CliExecutable;
  readonly model: ModelId;
  readonly reasoningEffort: ReasoningEffort;
  readonly debounceMs: number;
  readonly timeoutMs: number;
  readonly maxPrefixChars: number;
  readonly maxSuffixChars: number;
  readonly maxWholeFileChars: number;
  readonly maxSuggestionLines: number;
  readonly usePersistentServer: boolean;
  readonly excludedFiles: readonly string[];
}

export interface RecentEdit {
  readonly line: number;
  readonly character: number;
  readonly insertedPreview: string;
  readonly insertedLength: number;
  readonly removedLength: number;
  readonly ageMs: number;
}

export interface SourceContext {
  readonly languageId: string;
  readonly fileName: string;
  readonly contextKind: "whole-file" | "smart-window";
  readonly fileHead: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly fileTail: string;
  readonly cursorLine: number;
  readonly cursorCharacter: number;
  readonly recentEdits: readonly RecentEdit[];
  readonly intentSignals: readonly string[];
  readonly maxSuggestionLines: number;
}

export type AuthenticationStatus =
  | { readonly kind: "chatgpt"; readonly detail: string }
  | { readonly kind: "api-key"; readonly detail: string }
  | { readonly kind: "access-token"; readonly detail: string }
  | { readonly kind: "unknown-auth"; readonly detail: string }
  | { readonly kind: "signed-out"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function asCliExecutable(value: string): CliExecutable {
  const candidate = value.trim();
  if (candidate.length === 0 || /[\r\n\0]/u.test(candidate)) {
    throw new Error("The Codex executable path is empty or invalid.");
  }

  return candidate as CliExecutable;
}

export function asModelId(value: string): ModelId {
  const candidate = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(candidate)) {
    throw new Error("The Codex model must contain only letters, numbers, dots, underscores, and hyphens.");
  }

  return candidate as ModelId;
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}
