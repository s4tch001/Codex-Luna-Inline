# Codex Luna Inline

Automatic inline code completion for VS Code using **GPT-5.6 Luna** through the local **Codex CLI**. It uses the ChatGPT/Codex entitlement of your signed-in account (for example, ChatGPT Plus)—**no OpenAI API key, SDK, endpoint, or separate API billing**.

## What is new in v0.2

- Reads the entire file up to 80,000 characters. Larger files use a smart head/cursor/tail window.
- Includes the last six edits and local intent signals such as TODOs, member access, expressions, imports, and declarations.
- Keeps the local Codex app-server persistent, so a new CLI process is not started for every suggestion.
- Disables completion-unrelated tools, plugins, skills, MCP, shell snapshots, and file/network actions.
- Reuses the predicted remainder immediately as you type the beginning of the current suggestion.
- Reduces the default typing debounce from 700 ms to 250 ms.

In a live two-case test on the development machine, both completions were correct: approximately 4.7 seconds for the cold request and 4.0 seconds for the following warm request. Actual latency varies with network conditions, account load, file size, and model service.

## Requirements

- VS Code 1.125 or newer.
- Current Codex CLI. Install or update it with:

  ```powershell
  npm install -g @openai/codex
  codex --version
  ```

- A ChatGPT account/plan with Codex access.

## Install the VSIX

From a terminal:

```powershell
code --install-extension ".\codex-luna-inline-0.2.0.vsix" --force
```

Or in VS Code: open **Extensions** → `…` → **Install from VSIX…**, then select the `.vsix` file. Reload the VS Code window if prompted.

## First setup and account selection

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **Codex Luna Inline: Choose / Sign in to ChatGPT Account**.
3. Choose **Sign in with ChatGPT**.
4. `codex login` opens the official ChatGPT browser login, where you choose the account/workspace.
5. When ready, the `Codex Luna` status bar item appears and the completion server warms up.

The Codex CLI does not expose a list of ChatGPT accounts to the extension. The actual account picker is in the secure browser login. To switch accounts, run **Codex Luna Inline: Switch ChatGPT Account**; it runs `codex logout` before opening a new browser login.

The account currently open in your browser and the account saved in Codex CLI may be different. Simply switching the browser account does not automatically change the VS Code extension account; use the account-switch command to change the CLI credential.

API-key and access-token authentication are intentionally rejected. `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` are removed from every child Codex process, so the extension uses only the persisted ChatGPT login.

## Usage

- Type in a supported text editor. After the default 250 ms pause, the extension requests an inline suggestion.
- Press `Tab` to accept the VS Code inline suggestion.
- Press `Alt+\` to request a suggestion immediately without the debounce.
- Click the `Codex Luna` status bar item for login and account actions.
- Run **Codex Luna Inline: Toggle Automatic Completions** to turn automatic suggestions on or off.

Automatic requests consume your available ChatGPT/Codex usage. Increase the debounce if you want to reduce request frequency.

## How intent prediction works

For files within `maxWholeFileChars`, the entire source is sent as clearly separated `beforeCursor` and `afterCursor` data. The request also includes the cursor location, recent edit previews, language, filename, and lightweight local intent signals. For oversized files, it preserves the file head, a large local cursor window, and the file tail so imports, nearby implementation, and ending structure remain visible.

Source text and comments are explicitly marked as untrusted data, not instructions. The model is asked for structured JSON only; the extension then removes duplicated suffixes, fences, and excessive lines before displaying the result.

## Safety and privacy

- The source context described above is sent to the Codex service through the authenticated local CLI.
- Only trusted workspaces are supported.
- `.env`, credentials, secret-named files, private keys, `.npmrc`, and `.pypirc` are excluded by default.
- Each completion thread is ephemeral, read-only, has no network/tool access, and cannot request approval.
- The process working directory is a separate extension storage folder; completion requests cannot edit project files.
- Prompts, source context, and generated completions are not logged.
- If the local CLI does not support app-server startup, an isolated `codex exec` fallback is used. You can also disable persistent mode for compatibility troubleshooting.

Review `codexLunaInline.excludedFiles` if your project has additional sensitive files. Do not enable the extension for code that must not be sent to Codex.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `codexLunaInline.enabled` | `true` | Turn automatic completions on or off |
| `codexLunaInline.codexPath` | `codex` | Executable name or absolute path |
| `codexLunaInline.model` | `gpt-5.6-luna` | Codex model slug |
| `codexLunaInline.reasoningEffort` | `low` | Completion speed/depth |
| `codexLunaInline.debounceMs` | `250` | Delay after typing |
| `codexLunaInline.timeoutMs` | `20000` | Per-request timeout |
| `codexLunaInline.maxPrefixChars` | `30000` | Local context before the cursor in oversized files |
| `codexLunaInline.maxSuffixChars` | `15000` | Local context after the cursor in oversized files |
| `codexLunaInline.maxWholeFileChars` | `80000` | Whole-file limit before using a smart window |
| `codexLunaInline.usePersistentServer` | `true` | Reuse the warm local Codex process |
| `codexLunaInline.maxSuggestionLines` | `12` | Maximum output lines |
| `codexLunaInline.excludedFiles` | Secret-file globs | Files that must not be sent |

## Troubleshooting

**`Codex CLI` / executable not found / access denied**

Install the current CLI with `npm install -g @openai/codex`, restart VS Code, then check `where.exe codex`. You can also set the full executable path in `codexLunaInline.codexPath`.

**Status says API auth is blocked**

Run **Codex Luna Inline: Switch ChatGPT Account**. This removes the current Codex credential and opens the ChatGPT login.

**No inline suggestion**

- Run **Codex Luna Inline: Check Login Status**.
- Make sure VS Code setting `editor.inlineSuggest.enabled` is enabled.
- Check whether the file matches an excluded-file pattern.
- Open **Codex Luna Inline: Show Output Log**.
- Luna may validly return no suggestion when the context is ambiguous.

**Completion is slow**

- Update the Codex CLI and keep `usePersistentServer` enabled.
- Keep reasoning effort at `low`; higher effort may be slower.
- Reduce `maxWholeFileChars` for very large files.
- The 250 ms debounce is only the typing wait; network/model latency is separate.

## Development

```powershell
npm install
npm test
npm run package
```

The output is `codex-luna-inline-0.2.0.vsix` in the project root.
