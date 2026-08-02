# Changelog

## 0.2.0

- Added persistent Codex app-server completions with isolated `codex exec` fallback.
- Added whole-file context up to a configurable limit and head/cursor/tail context for oversized files.
- Added recent-edit tracking and local intent signals for more predictive completions.
- Added structured completion output, a lean prompt, and prompt-injection boundaries.
- Added predictive remainder reuse while the user types an existing suggestion.
- Disabled completion-unrelated Codex tools, plugins, skills, MCP, and shell metadata.
- Reduced the default debounce to 250 ms and timeout to 20 seconds.
- Expanded the pure/protocol test suite to 17 passing tests.

## 0.1.0

- Added automatic VS Code inline completions through local `codex exec`.
- Added GPT-5.6 Luna and low-reasoning defaults.
- Added ChatGPT browser login, status, account switch, and logout commands.
- Enforced ChatGPT-only authentication without API keys.
- Added debounce, cancellation, cache, context limits, timeout, and secret-file exclusions.
- Added read-only ephemeral execution and prompt-injection defenses.
