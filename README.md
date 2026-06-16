# pi-prompt-gen

Generate or rewrite prompts inside Pi with a modal prompt enhancer.

## What it does

- rewrites a weak prompt without changing its core intent
- generates a solid prompt from a rough idea or vague issue statement
- runs a real read-only browse pass before enhancement to inspect the codebase
- reuses the currently selected Pi model for both browsing and final prompt generation
- can use a safe local browse-tool subset when those tools are available in Pi: `read`, `grep`, `find`, `ls`, `code_search`, `project_memory_read`, `project_memory_search`, `codegraph_explore`, `codegraph_node`, and `codegraph_status`
- adds internal bounded read-only browse tools for current git context and current-branch user/assistant session history
- keeps enhancement calls isolated from the parent session id and does not reuse full parent history
- stays strictly in prompt-generation mode instead of solving the underlying task

## Install

```bash
pi install git:github.com/bnema/pi-prompt-gen
```

Or install from a local checkout while developing:

```bash
pi install /path/to/pi-prompt-gen
```

## Requirements

- Pi with extension loading enabled
- Node.js 20+
- Pi TUI for the full modal experience

## How it behaves

`pi-prompt-gen` is for turning input like:

- a half-written implementation request
- a messy bug report turned into a better agent prompt

into a stronger prompt that keeps the same general idea, adds a little structure, and may point at relevant files such as `internal/sidebar.go` when they are likely useful.

The enhancer does **not** debug, investigate root cause, or implement the work itself. Its only job is to produce a better prompt.

## Usage

Open the modal with:

```text
/prompt
```

Run the full enhancer inline with a plain string argument:

```text
/prompt fix the sidebar sorting by recent first
```

That inline path reuses the same isolated browse + enhance pipeline as the modal, shows live footer status/progress while it runs, then copies the result to the clipboard and writes it back into the Pi editor.

Global shortcut registered by the extension:

```text
Ctrl+Shift+G
```

If your terminal does not report `Ctrl+Shift+G` distinctly, Pi may treat it as `Ctrl+G` and open the external editor instead.

When the modal opens, prefill order is:

1. command arguments
2. current Pi editor text
3. latest user message from the active session branch
4. blank draft

Default mode:

- non-empty draft → `rewrite`
- blank draft → `generate`

## Browse pass

Before generating the final enhanced prompt, `pi-prompt-gen` can run an isolated read-only browse pass. That pass can:

- inspect the repository with read-only file tools when available: `read`, `grep`, `find`, `ls`
- use local code and project-discovery tools when available: `code_search`, `project_memory_read`, `project_memory_search`, `codegraph_explore`, `codegraph_node`, `codegraph_status`
- inspect bounded current git context through an internal read-only `git_context` tool
- inspect bounded current-branch user/assistant conversation history through an internal read-only `session_history` tool
- select a small set of relevant file refs plus concise structured git/session context to inject into the final prompt

The internal browse-only tools are bounded on purpose:

- `git_context` is read-only and limited to branch/status/diff-style inspection for the current repository
- `session_history` only exposes current-branch user/assistant messages, not tool chatter or full session-tree state
- the final enhancement call receives only the scout's small structured output, not raw full diffs or full conversation history

When that browse pass runs, the modal shows progress and the inline command path shows footer status updates so you can see when it is examining the codebase, using tools, and generating the final prompt.

## Modal model

The modal is organized as:

- **Draft** — the text you are refining or expanding from
- **Result** — the enhanced prompt preview produced by the isolated model call

Mode labels are explicit in the UI:

- `rewrite` → refine a prompt
- `generate` → idea → prompt

## Modal shortcuts

- `Enter` — enhance the current draft, then re-enhance after a result exists
- `Shift+Enter` — insert newline
- `Alt+M` — toggle rewrite/generate mode
- `Alt+R` — regenerate a materially different alternative with a fresh isolated request
- `Alt+C` — clear the draft
- `Alt+Y` — copy the enhanced result
- `Alt+A` — apply the enhanced result back into the main Pi editor
- `Alt+S` — send the enhanced result as a user message, clear the parent editor, and close the modal
- `Esc` — close the modal, or abort the in-flight enhancement

`copy`, `apply`, and `send` operate on the **enhanced result** only. If no result exists yet, the modal asks you to enhance first instead of silently using the raw draft.

If the preview is truncated, the modal tells you that the hidden lines still count: copy/apply/send use the full result.

## Isolation guarantees

The enhancement pipeline uses explicit inputs only:

- the selected model
- the current cwd for the isolated browse pass
- the raw user draft as the user message
- the rewrite/generate guardrail harness as the system prompt
- a bounded structured browse result: relevant file refs plus optional concise git/session context selected by the scout

It does **not** reuse the parent session id, parent session history wholesale, or the full conversation tree.

## Non-TUI behavior

The full modal is a TUI feature.

- in Pi TUI mode, `/prompt` opens as an overlay modal and `/prompt <text>` runs inline
- in other UI-capable modes, it uses inline enhancement behavior
- in no-UI contexts, it fails explicitly and asks you to use Pi TUI or another UI-capable session

## Develop

```bash
npm install
npm run typecheck
npm test
pi -e .
```
