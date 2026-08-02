import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { CodexAppServer } = require("../dist/codexAppServer.js");
const { buildCompletionPrompt, sanitizeCompletion } = require("../dist/pure.js");

const output = {
  appendLine(line) {
    process.stdout.write(`${line}\n`);
  }
};
const token = {
  isCancellationRequested: false,
  onCancellationRequested() {
    return { dispose() {} };
  }
};
const configuration = {
  enabled: true,
  codexPath: "codex",
  model: "gpt-5.6-luna",
  reasoningEffort: "low",
  debounceMs: 250,
  timeoutMs: 30_000,
  maxPrefixChars: 30_000,
  maxSuffixChars: 15_000,
  maxWholeFileChars: 80_000,
  maxSuggestionLines: 12,
  usePersistentServer: true,
  excludedFiles: []
};
const cases = [
  {
    name: "expression",
    prefix: "function add(a: number, b: number): number {\n  return ",
    suffix: ";\n}\n",
    intentSignals: ["complete-expression"]
  },
  {
    name: "member-and-comment",
    prefix: "interface User { active: boolean; name: string }\nconst users: User[] = [];\n// TODO: keep active users\nconst active = users.",
    suffix: ";\n",
    intentSignals: ["follow-nearby-comment-or-task", "complete-member-access"]
  }
];

const server = new CodexAppServer(process.cwd(), output);
try {
  for (const benchmarkCase of cases) {
    const context = {
      languageId: "typescript",
      fileName: "benchmark.ts",
      contextKind: "whole-file",
      fileHead: "",
      prefix: benchmarkCase.prefix,
      suffix: benchmarkCase.suffix,
      fileTail: "",
      cursorLine: benchmarkCase.prefix.split("\n").length - 1,
      cursorCharacter: benchmarkCase.prefix.length - benchmarkCase.prefix.lastIndexOf("\n") - 1,
      recentEdits: [],
      intentSignals: benchmarkCase.intentSignals,
      maxSuggestionLines: 12
    };
    const startedAt = performance.now();
    const raw = await server.complete(buildCompletionPrompt(context), configuration, token);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const completion = sanitizeCompletion(raw, context.prefix, context.suffix, 12);
    process.stdout.write(`${JSON.stringify({ name: benchmarkCase.name, elapsedMs, raw, completion })}\n`);
  }
} finally {
  server.dispose();
}
