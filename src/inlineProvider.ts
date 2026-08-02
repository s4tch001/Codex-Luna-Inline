import * as vscode from "vscode";

import { AuthenticationManager } from "./authentication.js";
import { CodexCli } from "./codexCli.js";
import { readConfiguration } from "./config.js";
import { buildSourceContext, RecentEditTracker } from "./contextBuilder.js";
import { isPathExcluded } from "./pure.js";
import { ProcessCancelledError } from "./processRunner.js";
import type { ExtensionConfiguration } from "./types.js";

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 100;

interface CacheEntry {
  readonly completion: string;
  readonly expiresAt: number;
}

interface PredictionEntry {
  readonly originalOffset: number;
  readonly anchor: string;
  readonly suffixAnchor: string;
  readonly completion: string;
  readonly expiresAt: number;
}

function delay(milliseconds: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise<void>((resolve) => {
    if (token.isCancellationRequested) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      disposable.dispose();
      resolve();
    }, milliseconds);
    const disposable = token.onCancellationRequested(() => {
      clearTimeout(timeout);
      disposable.dispose();
      resolve();
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cacheKey(
  document: vscode.TextDocument,
  position: vscode.Position,
  configuration: ExtensionConfiguration
): string {
  return [
    document.uri.toString(),
    String(document.version),
    String(document.offsetAt(position)),
    String(configuration.model),
    configuration.reasoningEffort,
    String(configuration.maxWholeFileChars),
    String(configuration.maxSuggestionLines)
  ].join("|");
}

export class CodexInlineCompletionProvider
  implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly busyEmitter = new vscode.EventEmitter<boolean>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly predictions = new Map<string, PredictionEntry>();
  private activeRequest: vscode.CancellationTokenSource | undefined;
  private lastReportedError = "";

  public readonly onDidChangeBusy = this.busyEmitter.event;

  public constructor(
    private readonly cli: CodexCli,
    private readonly authentication: AuthenticationManager,
    private readonly recentEdits: RecentEditTracker,
    private readonly output: vscode.OutputChannel
  ) {}

  public dispose(): void {
    this.activeRequest?.cancel();
    this.activeRequest?.dispose();
    this.busyEmitter.dispose();
    this.cache.clear();
    this.predictions.clear();
  }

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | undefined> {
    let configuration: ExtensionConfiguration;
    try {
      configuration = readConfiguration();
    } catch (error) {
      this.reportError(error);
      return undefined;
    }

    if (!configuration.enabled || !this.supportsDocument(document, configuration)) {
      return undefined;
    }

    const predictedRemainder = this.reusePrediction(document, position);
    if (predictedRemainder !== undefined) {
      return this.toCompletionList(predictedRemainder, position);
    }

    const key = cacheKey(document, position, configuration);
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return this.toCompletionList(cached.completion, position);
    }

    this.activeRequest?.cancel();
    this.activeRequest?.dispose();
    const requestCancellation = new vscode.CancellationTokenSource();
    this.activeRequest = requestCancellation;
    const outerCancellation = token.onCancellationRequested(() => requestCancellation.cancel());

    try {
      const debounceMs = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke
        ? 0
        : configuration.debounceMs;
      await delay(debounceMs, requestCancellation.token);
      if (requestCancellation.token.isCancellationRequested) {
        return undefined;
      }

      if (!(await this.authentication.hasChatGptLogin())) {
        return undefined;
      }

      this.busyEmitter.fire(true);
      const sourceContext = buildSourceContext(
        document,
        position,
        configuration,
        this.recentEdits.forDocument(document)
      );
      const completion = await this.cli.complete(sourceContext, configuration, requestCancellation.token);
      if (completion === undefined || requestCancellation.token.isCancellationRequested) {
        return undefined;
      }

      this.remember(key, completion);
      this.rememberPrediction(document, position, completion);
      this.lastReportedError = "";
      return this.toCompletionList(completion, position);
    } catch (error) {
      if (!(error instanceof ProcessCancelledError)) {
        this.reportError(error);
      }
      return undefined;
    } finally {
      outerCancellation.dispose();
      if (this.activeRequest === requestCancellation) {
        this.activeRequest = undefined;
      }
      requestCancellation.dispose();
      this.busyEmitter.fire(false);
    }
  }

  private supportsDocument(
    document: vscode.TextDocument,
    configuration: ExtensionConfiguration
  ): boolean {
    if (document.isClosed || document.uri.scheme === "output" || document.uri.scheme === "git") {
      return false;
    }

    const comparablePath = (document.uri.fsPath || document.fileName).replaceAll("\\", "/");
    return !isPathExcluded(comparablePath, configuration.excludedFiles);
  }

  private toCompletionList(completion: string, position: vscode.Position): vscode.InlineCompletionList {
    return new vscode.InlineCompletionList([
      new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))
    ]);
  }

  private remember(key: string, completion: string): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey === "string") {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { completion, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private rememberPrediction(
    document: vscode.TextDocument,
    position: vscode.Position,
    completion: string
  ): void {
    const source = document.getText();
    const originalOffset = document.offsetAt(position);
    const anchorStart = Math.max(0, originalOffset - 96);
    this.predictions.set(document.uri.toString(), {
      originalOffset,
      anchor: source.slice(anchorStart, originalOffset),
      suffixAnchor: source.slice(originalOffset, originalOffset + 96),
      completion,
      expiresAt: Date.now() + CACHE_TTL_MS
    });
  }

  private reusePrediction(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string | undefined {
    const key = document.uri.toString();
    const prediction = this.predictions.get(key);
    if (prediction === undefined) {
      return undefined;
    }
    if (prediction.expiresAt <= Date.now()) {
      this.predictions.delete(key);
      return undefined;
    }

    const source = document.getText();
    const currentOffset = document.offsetAt(position);
    const consumedLength = currentOffset - prediction.originalOffset;
    const anchorStart = prediction.originalOffset - prediction.anchor.length;
    if (
      consumedLength < 0
      || consumedLength >= prediction.completion.length
      || source.slice(anchorStart, prediction.originalOffset) !== prediction.anchor
      || source.slice(prediction.originalOffset, currentOffset) !== prediction.completion.slice(0, consumedLength)
      || source.slice(currentOffset, currentOffset + prediction.suffixAnchor.length) !== prediction.suffixAnchor
    ) {
      this.predictions.delete(key);
      return undefined;
    }

    return prediction.completion.slice(consumedLength);
  }

  private reportError(error: unknown): void {
    const message = errorMessage(error);
    this.output.appendLine(`[error] ${message}`);
    if (message === this.lastReportedError) {
      return;
    }

    this.lastReportedError = message;
    void vscode.window.showWarningMessage(
      `Codex Luna inline completion failed: ${message}`,
      "Show log"
    ).then((action) => {
      if (action === "Show log") {
        this.output.show(true);
      }
    });
  }
}
