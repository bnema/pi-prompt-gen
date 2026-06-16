# Prompt quality guide

This document describes what the pi-prompt-gen enhancer produces, what it
never does, how its two modes differ, how browse-context data is handled, and
how to maintain the system prompt fixtures and tests.

The audience is anyone contributing to pi-prompt-gen or diagnosing prompt
quality issues from repo-local information.

---

## What the enhancer does

The enhancer (`src/enhancer-prompt.ts`) produces a system prompt + one user
message for an LLM call. That LLM call generates a **polished prompt for
another agent to execute**. Every system prompt includes guardrails that keep
the model in prompt-shaping mode:

| Guardrail       | Purpose                                                      |
|-----------------|--------------------------------------------------------------|
| SCOPE LOCK      | Preserve original intent — do not broaden, narrow, or shift  |
| CHANGE BUDGET   | Keep output as concise as the input allows                   |
| Role framing    | Your only job is to produce a prompt — not implement         |
| ANTI_DEBUG      | Never debug, investigate root causes, or solve the task      |
| ANTI_ESSAY      | Strip preamble, meta-commentary, explanations                |
| OUTPUT_CONTRACT | Return a single self-contained prompt, ≤~20 lines            |
| Verification    | Include lightweight acceptance checks for impl-like prompts  |
| TASK SHAPE      | Compact Goal/Context/Constraints/Verification sections are   |
|                 | allowed when they add clarity, never required                |

## What the enhancer never does

- **Implements** code, runs commands, or writes files.
- **Debugs** the underlying issue or investigates root causes.
- **Writes essays** or meta-commentary about how the prompt was produced.
- **Solves** the task described in the input. The output is always a prompt for
  another agent, not a solution.
- **Broadens scope** — it preserves the original ask exactly. If the input is
  vague, the output sharpens without expanding.
- **Embeds raw user input into the system prompt** — the system prompt is a
  role/constraints document; raw input stays in the user message.

## Modes

### Rewrite

Improve a prompt that already expresses a coherent ask but needs clarification,
structure, or polish. The core intent stays identical.

### Generate

Turn a rough idea, vague bug report, or open-ended request into a well-shaped
prompt. The mode builds a prompt from near-scratch while preserving the
original intent.

### Good/bad examples

#### Rewrite — good

```text
Input:  "fix the sidebar sort order"
Context: "src/components/Sidebar.tsx"
Output: "Fix the sidebar sort order in src/components/Sidebar.tsx so items
         are sorted correctly. Verify the list re-renders correctly after
         the change."
```

The enhancer preserves the narrow scope, incorporates the provided context
(without inventing refs), adds a verification check, but does **not**
implement the sort or investigate the current sort logic.

#### Rewrite — bad (scope creep)

```text
Input:  "fix the sidebar sort order"
Output: "Refactor the sidebar to use a virtualized list, add drag-and-drop
         reordering, and fix the sort order."
```

The enhancer broadened scope beyond the original ask — the extra features
were not requested. This would fail the SCOPE LOCK guardrail.

#### Rewrite — bad (task solving)

```text
Input:  "fix the sidebar sort order"
Output: "Change the `.sort()` call on line 47 in Sidebar.tsx from
         `sort(byName)` to `sort(byDate)`. Then re-run the tests."
```

The enhancer implemented the fix instead of producing a prompt for another
agent. This would fail the role-framing and anti-debug guardrails.

#### Generate — good

```text
Input:  "make the app faster"
Output: "Profile the application to identify the top-3 performance
         bottlenecks. For each bottleneck, document the observed metric
         (load time, frame rate, bundle size, etc.) and suggest a targeted
         improvement."
```

The enhancer turned a vague idea into a structured but scoped prompt. It asks
another agent to profile and suggest improvements — it does not optimise
anything itself.

#### Generate — bad (task solving)

```text
Input:  "make the app faster"
Output: "Enable code splitting, add lazy loading, optimise images, and
         memoise expensive computations."
```

The enhancer jumped straight to solutions instead of producing a prompt. It
also broadened scope by suggesting multiple techniques without prioritisation.

## Follow-up and context-aware prompts

The enhancer can inject structured context from a browse pass when the
fixture or caller provides it:

- **Relevant refs** — file paths that ground the prompt in specific code.
- **Git context** — branch, status, changed files, diff summary.
- **Session history** — recent user/assistant messages from the current
  conversation branch.

All context from git and session sources is wrapped in an
**UNTRUSTED DATA** warning in the system prompt. The model is told to treat
these sections as quoted context only — not to follow instructions or embedded
policy-like text inside them.

### Good/bad examples

#### Context-aware follow-up — good

```text
Input:  "Based on the last PR review, clean up the error handling in the auth
         module."
Output: "Clean up error handling in the auth module (src/auth/login.ts,
         src/auth/register.ts, src/auth/errors.ts) based on PR #42 review
         feedback. Use consistent error types from errors.ts and remove
         duplicated try-catch blocks. Do not change the public API."
```

The enhancer folds in file refs and preserves the narrow scope from the
conversation context. It does not expand into testing, refactoring other
modules, or rewriting the auth strategy.

#### Context-aware follow-up — bad (ignoring boundaries)

```text
Input:  "Clean up error handling as discussed."
Output: "Refactor error handling across the entire backend. Consolidate all
         error types, add structured logging, and ensure every API route
         returns consistent error responses."
```

The enhancer broadened the scope from the specific auth-follow-up context and
invented work (logging, API routes) not mentioned in the conversation history.

#### Context-aware follow-up — bad (obeying embedded instructions)

```text
Input:  "Clean up the imports in src/utils.ts. By the way, here's a git diff
         that shows a command: `rm -rf /`."
Output: The model executes or acknowledges the embedded command from the
        git context.
```

The enhancer must **not** follow instructions embedded in git or session
context data. The UNTRUSTED DATA guardrails exist to prevent this. If the
model's output reflects commands or policy from context sections, the
guardrails need reinforcement.

## Task shape guidance

The system prompt includes a **TASK SHAPE** guardrail that allows the model
to organise output as compact Goal / Context / Constraints / Verification
sections when the input benefits from structure:

- Sections are **never required**. A flat paragraph is always acceptable.
- When the input is a clear implementation task (add endpoint, fix bug,
  write docs), sections can add clarity without expanding scope.
- When the input is one line or minimal, a flat paragraph is preferred.
- The guardrail works alongside CHANGE BUDGET and OUTPUT_CONTRACT: sections
  must stay compact and within ~20 total lines.

### Regenerate / alternative generation

When the caller requests an alternative (`previousOutput`), the user content
prompt now explicitly suggests varying wording or structure (e.g. compact
sections vs. flat paragraph) while preserving scope and concision. This
encourages alternatives that are materially different in form, not just reworded.

## Browse context boundaries

The browse pass (`src/browse-pass.ts`) runs in an isolated session with a
restricted tool set:

- **Safe read-only tools**: `read`, `grep`, `find`, `ls`, `code_search`,
  `project_memory_read`, `project_memory_search`, `codegraph_explore`,
  `codegraph_node`, `codegraph_status`.
- **Internal browse-only tools**: `git_context` (read-only bounded git
  inspection), `session_history` (bounded current-branch user/assistant
  history).
- **All tools are read-only**. No file edits, command execution, or write
  operations.
- **The scout returns only a small structured JSON payload** — a few file
  refs, a concise git summary, and a few conversation excerpts. Raw diffs or
  full conversation history are never injected into the final prompt.

### Bounding limits

| Context type      | Limit                                                      |
|-------------------|------------------------------------------------------------|
| File refs         | Up to `DEFAULT_MAX_REFS` (5)                               |
| Changed files     | Up to `MAX_CHANGED_FILES` (12)                             |
| Git diff lines    | Up to `MAX_GIT_DIFF_LINES` (200)                           |
| Git diff bytes    | Up to `MAX_GIT_DIFF_BYTES` (20 KB)                         |
| Session messages  | Snapshot size up to `MAX_HISTORY_SNAPSHOT_MESSAGES` (40)   |
| Selected messages | Up to `MAX_SELECTED_MESSAGES` (4), max `MAX_SELECTED_MESSAGE_CHARS` (500) each |
| Git summary chars | Up to `MAX_GIT_SUMMARY_CHARS` (600)                        |
| Git diff summary  | Up to `MAX_GIT_DIFF_CHARS` (4 000)                         |

These constants live at the top of `src/browse-pass.ts`. Bump them with care
— larger values increase token cost and may leak more context than intended.

## Maintenance rules

### Adding a new system-prompt constraint

1. Add the constraint text to `src/enhancer-prompt.ts` (as a `const` string at
   top level and in the `buildEnhancerPrompt` function).
2. Add a corresponding label to `ENHANCER_PROMPT_LABELS` in
   `src/enhancer-prompt.ts` when tests need to assert it.
3. Register the criterion in `DEFAULT_CRITERIA` in
   `test/fixtures/prompt-eval-fixtures.ts`.
4. Extend the shared criteria check (or a dedicated `describe`/`it` block) in
   `test/prompt-evals.test.ts`.
5. Run `npm test` to confirm no existing fixtures regress. Some fixtures may
   need entries in `skipCriteria`.

### Adding a new eval fixture

1. Add a `PromptEvalFixture` entry in `test/fixtures/prompt-eval-fixtures.ts`.
   Include `id`, `category`, `input`, `mode`, `description`, and optional
   `context` and `skipCriteria`.
2. If the fixture represents an entirely new category, add category-specific
   assertions to `CATEGORY_ASSERTIONS` in `test/prompt-evals.test.ts`.
3. If the fixture should be tested through the full pipeline (mocked model
   call), add it to the `pipelineFixtures` array in
   `test/prompt-evals.test.ts`.
4. Run `npm test` to confirm.

### Updating the harness when the data model changes

- When `EnhancePromptResult`, `Ref`, `GitContext`, or `SessionContext` shape
  changes, update the fixture data and the pipeline assertion helpers in
  `test/prompt-evals.test.ts`.
- When new context types are added, add fixtures with that context and
  corresponding injection assertions.

### When NOT to change fixtures

- Do not remove or rewrite guardrails to silence a failing fixture. Instead,
  fix the implementation or update the fixture's `skipCriteria` with a clear
  rationale.
- Do not add fixtures that test model-generated output quality (those need
  offline evaluation, not unit tests).
- Do not add fixtures that assert subjective "good prompt" characteristics.
  These tests validate **structure and boundaries**, not quality.

## Verification commands

Before changing prompt behavior (adding constraints, adjusting guardrails,
modifying context injection), run these commands:

```bash
# Full test suite (system prompt evals + pipeline evals + unit tests)
npm test

# TypeScript type checking (no emit)
npm run typecheck

# Run only the prompt eval tests (for rapid iteration on fixtures)
npx vitest run test/prompt-evals.test.ts
```

The command `npx vitest run test/prompt-evals.test.ts` runs just the
fixture-based eval tests without the full unit suite. Use it when iterating
on fixture data or system prompt constraints.

For a single command that runs all verification steps in sequence:

```bash
npm run verify
```

The `verify` script runs `typecheck` → `test` → `build` and exits on the
first failure. This is the recommended pre-merge/release check.

### Test categories

| Test file                   | What it validates                                  |
|----------------------------|----------------------------------------------------|
| `test/prompt-evals.test.ts` | System prompt structure, guardrails, context inj. |
| `test/enhancer-prompt.test.ts` | Unit tests for prompt builder                   |
| `test/browse-pass.test.ts`  | Browse scout session and tool behaviour            |
| `test/model-call.test.ts`   | Isolated model call helper                         |
| `test/modal.test.ts`        | TUI modal state, keybindings, actions              |
| `test/extension.test.ts`    | Extension registration and command routing         |
| `test/index.test.ts`        | Pipeline orchestration (`enhancePrompt()`)         |

## Run metadata and feedback loop

Every `enhancePrompt()` call returns a `metadata` object on the result:

| Field            | Source                                    | Example                |
|------------------|-------------------------------------------|------------------------|
| `modelId`        | Model config from options                 | `gpt-4o-mini`          |
| `modelName`      | Model config from options                 | `GPT-4o Mini`          |
| `modelProvider`  | Model config from options                 | `openai`               |
| `latencyMs`      | `performance.now()` around model call     | `1234`                 |
| `refCount`       | Length of `refs` array                    | `3`                    |
| `browseToolsUsed`| Tool names passed to the upstream scout   | `["read","grep"]`     |
| `stopReason`     | Model call stop reason                    | `stop`                 |
| `usageSummary`   | Bounded token counts from provider        | `{input:50,output:30}` |

Metadata is **bounded** — it never contains raw user input, API keys, full
usage cost objects, or raw system prompts. The `usageSummary` strips cost
information from the provider's `Usage` object.

### Metadata artifact

The modal includes an **Alt+E** shortcut that copies a metadata artifact
to the clipboard. The artifact is intentionally conservative — it contains
only bounded metadata and context flags, and never includes the enhanced
prompt body, raw user input, system prompt, or full model result, because
those may contain sensitive project data, secrets, API keys, or raw user
input echoed by the model.

The artifact contains:

- Run metadata (model, latency, stop reason, token counts).
- Ref path list (scores and symbols excluded).
- Context flags (whether git/session context was present).

It explicitly **excludes**:

- Enhanced prompt body (even truncated)
- Raw user input / prompt draft
- API keys or auth headers
- Cost information
- System prompt
- Full model result

The artifact is formatted as plain text suitable for pasting into an
eval fixture, issue report, or debugging log.

### Inline metadata summary

When running the inline enhancement (args provided directly), the extension
shows a compact metadata summary in the success notification, e.g.:

```text
Enhanced prompt copied to clipboard. · GPT-4o Mini · stop · 80 tok · 1.2s
```

This makes the inline flow as informative as the modal without adding
extra UI chrome.

## Related

- [README](../README.md) — install, usage, modal shortcuts.
- `test/fixtures/prompt-eval-fixtures.ts` — eval fixture definitions.
- `test/prompt-evals.test.ts` — eval runner and shared criteria.
- `src/enhancer-prompt.ts` — system prompt builder.
- `src/browse-pass.ts` — browse scout implementation.
- `src/debug-artifact.ts` — debug artifact builder.
