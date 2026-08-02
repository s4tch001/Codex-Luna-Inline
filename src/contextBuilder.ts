import * as path from "node:path";

import * as vscode from "vscode";

import { inferIntentSignals, sliceSourceContext } from "./pure.js";
import type {
  ExtensionConfiguration,
  RecentEdit,
  SourceContext
} from "./types.js";

const MAX_RECENT_EDITS = 6;
const RECENT_EDIT_TTL_MS = 60_000;
const MAX_EDIT_PREVIEW_CHARS = 240;
const MAX_TRACKED_DOCUMENTS = 50;

interface StoredEdit {
  readonly line: number;
  readonly character: number;
  readonly insertedPreview: string;
  readonly insertedLength: number;
  readonly removedLength: number;
  readonly timestamp: number;
}

function preview(value: string): string {
  if (value.length <= MAX_EDIT_PREVIEW_CHARS) {
    return value;
  }
  const head = value.slice(0, 150);
  const tail = value.slice(-70);
  return `${head}\n…<${value.length - 220} chars omitted>…\n${tail}`;
}

export class RecentEditTracker implements vscode.Disposable {
  private readonly edits = new Map<string, StoredEdit[]>();
  private readonly subscription: vscode.Disposable;

  public constructor() {
    this.subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      const key = event.document.uri.toString();
      const existing = this.edits.get(key) ?? [];
      const timestamp = Date.now();
      const additions = event.contentChanges.map((change): StoredEdit => ({
        line: change.range.start.line,
        character: change.range.start.character,
        insertedPreview: preview(change.text),
        insertedLength: change.text.length,
        removedLength: change.rangeLength,
        timestamp
      }));
      this.edits.set(key, [...existing, ...additions].slice(-MAX_RECENT_EDITS));
      if (this.edits.size > MAX_TRACKED_DOCUMENTS) {
        const oldestKey = this.edits.keys().next().value;
        if (typeof oldestKey === "string") {
          this.edits.delete(oldestKey);
        }
      }
    });
  }

  public dispose(): void {
    this.subscription.dispose();
    this.edits.clear();
  }

  public forDocument(document: vscode.TextDocument): readonly RecentEdit[] {
    const now = Date.now();
    const key = document.uri.toString();
    const recent = (this.edits.get(key) ?? []).filter((edit) => now - edit.timestamp <= RECENT_EDIT_TTL_MS);
    this.edits.set(key, recent);
    return recent.map((edit) => ({
      line: edit.line,
      character: edit.character,
      insertedPreview: edit.insertedPreview,
      insertedLength: edit.insertedLength,
      removedLength: edit.removedLength,
      ageMs: now - edit.timestamp
    }));
  }
}

export function buildSourceContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  configuration: ExtensionConfiguration,
  recentEdits: readonly RecentEdit[]
): SourceContext {
  const source = document.getText();
  const offset = document.offsetAt(position);
  const slices = sliceSourceContext(
    source,
    offset,
    configuration.maxWholeFileChars,
    configuration.maxPrefixChars,
    configuration.maxSuffixChars
  );
  const workspacePath = vscode.workspace.asRelativePath(document.uri, false);
  const fileName = workspacePath === document.uri.fsPath
    ? path.basename(document.uri.fsPath || document.fileName)
    : workspacePath;

  return {
    languageId: document.languageId,
    fileName: fileName.replaceAll("\\", "/"),
    ...slices,
    cursorLine: position.line,
    cursorCharacter: position.character,
    recentEdits,
    intentSignals: inferIntentSignals(slices.prefix, slices.suffix),
    maxSuggestionLines: configuration.maxSuggestionLines
  };
}
