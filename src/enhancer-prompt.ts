/**
 * Enhancer prompt builder.
 *
 * Produces a system prompt for an LLM that rewrites or generates user-facing
 * prompts. The harness is scoped strictly to prompt-engineering — it must
 * never implement, debug, investigate, or solve the underlying task.
 *
 * Supports two modes:
 * - "rewrite"   — improve a poorly written prompt while preserving intent
 * - "generate"  — turn a rough idea into a well-structured prompt
 */

export type EnhancerMode = "rewrite" | "generate";

// ---------------------------------------------------------------------------
// Prompt-value sanitisation
// ---------------------------------------------------------------------------

/**
 * Convert a value to a single-line safe display string suitable for
 * interpolation into a prompt template.
 *
 * - Strips control characters (except space-preserving replacements for
 *   newlines, carriage-returns, and tabs).
 * - Escapes XML special characters so that `<entry_point>…</entry_point>`
 *   tag boundaries cannot be broken by a malicious or pathological path.
 */
function toSafeDisplay(value: string): string {
  return value
    .replace(/\x00/g, "") // null
    .replace(/[\x01-\x08]/g, "") // other controls
    .replace(/[\x0B]/g, "") // vertical tab
    .replace(/[\x0C]/g, "") // form feed
    .replace(/[\x0E-\x1F]/g, "") // more controls
    .replace(/[\x7F]/g, "") // DEL
    .replace(/\r/g, " ") // carriage return → space
    .replace(/\n/g, " ") // newline → space
    .replace(/\t/g, " ") // tab → space
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
}

export interface BuildEnhancerPromptOptions {
  /** Whether to rewrite an existing prompt or generate from a rough idea. */
  mode: EnhancerMode;
  /** Optional small set of relevant file/code references. */
  relevantRefs?: string[];
  /** Optional suggested entry-point file path. */
  entryPoint?: string;
}

const SCOPE_LOCK =
  "SCOPE LOCK: Preserve the user's original intent exactly. Do not broaden, " +
  "narrow, or shift the ask. If the input is vague, sharpen it \u2014 don't expand it.";

const CHANGE_BUDGET =
  "CHANGE BUDGET: Keep the output as concise as the input allows. A one-line " +
  "idea must not become an essay. Every sentence must carry signal.";

const ROLE_FRAMING =
  "Your only job is to produce a polished prompt for another agent to execute. " +
  "You do NOT implement code, run commands, write files, debug problems, " +
  "investigate root causes, or solve the task yourself. Return ONLY the prompt.";

const ANTI_DEBUG =
  "NEVER debug, investigate, pinpoint root causes, or attempt to solve the " +
  "underlying issue yourself. If the input describes a bug or problem, your " +
  "output is a prompt that asks ANOTHER agent to fix it \u2014 not a fix.";

const ANTI_ESSAY =
  "RESIST essay-length output. Strip preamble, meta-commentary, and " +
  "explanations. The output is a ready-to-send prompt, not a memo about " +
  "how you arrived at it.";

const OUTPUT_CONTRACT =
  "OUTPUT CONTRACT: Return a single, self-contained prompt ready to be sent to " +
  "the next agent. Structure it cleanly (one paragraph or short bullet list " +
  "if helpful) but never exceed ~20 lines.";

const REWRITE_INSTRUCTION =
  "Improve the following prompt by clarifying wording, fixing ambiguity, and " +
  "adding structure where helpful. Keep the same goal and scope.";

const GENERATE_INSTRUCTION =
  "Turn this rough idea into a clear, concise prompt that another agent can " +
  "follow to implement or investigate it. Preserve the original intent.";

/**
 * Build a system prompt for the prompt-enhancer LLM call.
 *
 * The returned string is a complete system message that includes role
 * framing, anti-scope-creep, anti-debugging, and anti-essay guardrails.
 * Raw user task text stays in the user message, not in this system prompt.
 *
 * @example
 *
 * ```ts
 * const prompt = buildEnhancerPrompt({
 *   mode: "rewrite",
 *   relevantRefs: ["src/components/Sidebar.tsx"],
 *   entryPoint: "src/components/Sidebar.tsx",
 * });
 * ```
 */
export function buildEnhancerPrompt(options: BuildEnhancerPromptOptions): string {
  const modeInstruction =
    options.mode === "rewrite" ? REWRITE_INSTRUCTION : GENERATE_INSTRUCTION;

  const sections: string[] = [
    "# Role\nYou are a prompt-engineering assistant. Your output is a prompt for another AI agent, not an implementation.",
    "",
    modeInstruction,
    "",
    "## Constraints",
    "- ".concat(SCOPE_LOCK),
    "- ".concat(CHANGE_BUDGET),
    "- ".concat(ROLE_FRAMING),
    "- ".concat(ANTI_DEBUG),
    "- ".concat(ANTI_ESSAY),
    "- ".concat(OUTPUT_CONTRACT),
  ];

  if (options.relevantRefs && options.relevantRefs.length > 0) {
    sections.push(
      "",
      "## Context",
      "The following files are relevant (do NOT read or modify them \u2014 only reference them as context):",
      ...options.relevantRefs.map((ref) => "- ".concat(toSafeDisplay(ref))),
    );
  }

  if (options.entryPoint) {
    sections.push("", "<entry_point>".concat(toSafeDisplay(options.entryPoint), "</entry_point>"));
  }

  return sections.join("\n");
}
