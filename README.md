# pi-prompt-gen

Generate or rewrite prompts inside Pi with a modal prompt enhancer.

## What it does

- rewrites a weak prompt without changing its core intent
- generates a solid prompt from a rough idea or vague issue statement
- adds only small, relevant repo refs and likely entrypoints
- reuses the currently selected Pi model
- keeps enhancement calls isolated from the parent session history and session id
- stays strictly in prompt-generation mode instead of solving the underlying task

## How it behaves

`pi-prompt-gen` is for turning input like:

- `there is an issue with the sidebar the ordering by recently doesn't work`
- a half-written implementation request
- a messy bug report turned into a better agent prompt

into a stronger prompt that keeps the same general idea, adds a little structure, and may point at relevant files such as `internal/sidebar.go` when they are likely useful.

The enhancer does **not** debug, investigate root cause, or implement the work itself. Its only job is to produce a better prompt.

## Usage

Open the modal with:

```text
/prompt
```

You can also prefill it directly:

```text
/prompt fix the sidebar sorting by recent first
```

Global shortcut:

```text
Ctrl+Shift+G
```

Prefill order:

1. command arguments
2. current Pi editor text
3. latest user message from the active session branch
4. blank draft

Default mode:

- non-empty draft → `rewrite`
- blank draft → `generate`

## Modal shortcuts

- `Enter` — enhance the current draft
- `Shift+Enter` — insert newline
- `Alt+M` — toggle rewrite/generate mode
- `Alt+R` — regenerate a materially different alternative with a fresh isolated request
- `Alt+C` — clear the draft
- `Alt+Y` — copy the current result to the clipboard
- `Alt+A` — apply the current result back into the main Pi editor
- `Alt+S` — send the current result as a user message
- `Esc` — close the modal, or abort the in-flight enhancement

## Isolation guarantees

The enhancement pipeline uses explicit inputs only:

- the selected model
- the current cwd for repo-scoped ref search
- the raw user draft as the user message
- the rewrite/generate guardrail harness as the system prompt

It does **not** reuse the parent session history or parent session id.

## Non-TUI behavior

The full modal is a TUI feature.

- in Pi TUI mode, it opens as an overlay modal
- in other UI-capable modes, it falls back to inline enhancement behavior
- in no-UI contexts, it fails explicitly and asks you to use Pi TUI or another UI-capable session

## Develop

```bash
npm install
npm run typecheck
npm test
pi -e .
```
