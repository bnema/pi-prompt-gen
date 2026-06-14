/**
 * pi-prompt-gen — composed prompt-shaping core.
 *
 * Wires the three Phase 2 pieces together:
 *   1. findRefs()      — repo-scoped file reference collection
 *   2. buildEnhancerPrompt() — rewrites/generates with anti-scope-creep guardrails
 *   3. makeModelCall() — isolated ephemeral model call (no parent session id/history)
 *
 * The `enhancePrompt()` function is the single entry point for the prompt-shaping
 * pipeline. It accepts the currently active Pi model + resolved credentials,
 * runs an isolated call, and returns a structured result.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { findRefs, type FileSystem, type Ref, type RefFinderOptions } from "./ref-finder.js";
import { buildEnhancerPrompt, type EnhancerMode } from "./enhancer-prompt.js";
import { makeModelCall, type ModelCallResult } from "./model-call.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** All options accepted by the composed enhancePrompt() function. */
export interface EnhancePromptOptions {
  /** The raw user prompt or rough idea to rewrite / generate from. */
  input: string;
  /**
   * Whether to rewrite an existing prompt ("rewrite") or generate a polished
   * prompt from a rough idea ("generate").  Defaults to "rewrite".
   */
  mode?: EnhancerMode;
  /**
   * Current working directory.  When provided, the ref-finder scans the repo
   * (or cwd as fallback) for relevant files to include as context.
   */
  cwd?: string;
  /** The currently selected Pi model — reused as-is (no separate model config). */
  model: Model<Api>;
  /** Resolved API key for the model's provider. */
  apiKey: string;
  /** Optional materialized request headers (e.g. custom provider headers). */
  headers?: Record<string, string>;
  /** Optional abort signal to cancel the model call. */
  signal?: AbortSignal;
  /** If provided, request a materially different alternative from this prior output. */
  previousOutput?: string;
  /** Injection point for ref-finder options (e.g. maxRefs, maxFiles). */
  refFinderOptions?: RefFinderOptions;
  /**
   * Injectable filesystem for the ref-finder.  Defaults to the real
   * `node:fs` via `createDefaultFS()`.  Swap in tests for deterministic
   * in-memory file trees.
   */
  fs?: FileSystem;
}

/** Structured result returned by enhancePrompt(). */
export interface EnhancePromptResult {
  /** The enhanced / generated prompt text produced by the model. */
  enhancedPrompt: string;
  /**
   * File references that were collected and used as scoped context.
   * Empty when `cwd` is not provided or no relevant files were found.
   */
  refs: Ref[];
  /**
   * The complete system prompt that was sent to the model. Includes the
   * role, mode instruction, guardrails, and scoped ref context only.
   * Raw user input stays in the user message. Useful for debugging.
   */
  systemPrompt: string;
  /** Raw result from the isolated model call (content, usage, stopReason, …). */
  modelResult: ModelCallResult;
}

// ---------------------------------------------------------------------------
// Composed core path
// ---------------------------------------------------------------------------

/**
 * Run the full prompt-shaping pipeline:
 *
 *   findRefs() → buildEnhancerPrompt() → makeModelCall()
 *
 * Every model call runs in **isolated ephemeral context** — no parent session
 * id is forwarded, no conversation history is attached, and only the supplied
 * system prompt + one user message are sent.
 *
 * @example
 *
 * ```ts
 * import { enhancePrompt } from "pi-prompt-gen";
 *
 * const result = await enhancePrompt({
 *   input: "fix the sidebar sort order",
 *   cwd: "/home/user/project",
 *   mode: "rewrite",
 *   model: currentModel,
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 * });
 *
 * console.log(result.enhancedPrompt);
 * // "Refine the sidebar component so that items are sorted
 * //  by `createdAt` descending (most recent first)."
 *
 * console.log(result.refs);
 * // [{ path: "src/components/Sidebar.tsx", score: 65, isEntrypoint: true, lineCount: 120 }]
 * ```
 */
export async function enhancePrompt(options: EnhancePromptOptions): Promise<EnhancePromptResult> {
  const {
    input,
    mode = "rewrite",
    cwd,
    model,
    apiKey,
    headers,
    signal,
    previousOutput,
    refFinderOptions,
    fs,
  } = options;

  // 1. Find relevant file references (repo-scoped)
  const refs: Ref[] = cwd
    ? await findRefs(input, cwd, refFinderOptions, fs)
    : [];

  // 2. Build the enhancer system prompt with scoped refs
  const refPaths = refs.map((r) => r.path);
  const entryPoint = refs.find((r) => r.isEntrypoint)?.path;

  const systemPrompt = buildEnhancerPrompt({
    mode,
    relevantRefs: refPaths.length > 0 ? refPaths : undefined,
    entryPoint,
  });

  // 3. Make the isolated model call (no session history, no parent session id)
  const modelResult = await makeModelCall({
    model,
    apiKey,
    headers,
    signal,
    systemPrompt,
    userContent: buildUserContent(input, previousOutput),
  });

  return {
    enhancedPrompt: modelResult.content,
    refs,
    systemPrompt,
    modelResult,
  };
}

function buildUserContent(input: string, previousOutput?: string): string {
  if (!previousOutput) return input;
  return [
    input,
    "",
    "Previous draft to avoid repeating verbatim:",
    previousOutput,
    "",
    "Produce a materially different alternative while preserving the same goal, scope, and level of concision.",
  ].join("\n");
}
