/**
 * pi-prompt-gen — composed prompt-shaping core.
 *
 * Wires the prompt-builder and isolated final model call together.
 * Repo/context examination now happens outside this file via an isolated
 * read-only browse pass that can provide explicit refs.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { buildEnhancerPrompt, type EnhancerMode } from "./enhancer-prompt.js";
import { makeModelCall, type ModelCallResult } from "./model-call.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Explicit repo/context ref supplied by an upstream browse pass. */
export interface Ref {
  /** Relative path to a relevant file. */
  path: string;
  /** Relevance score 0–100. Higher = more likely useful for the prompt. */
  score: number;
  /** Whether this file looks like an entry point. */
  isEntrypoint: boolean;
  /** Optional line count if the browse pass captured it. */
  lineCount?: number;
}

/** All options accepted by the composed enhancePrompt() function. */
export interface EnhancePromptOptions {
  /** The raw user prompt or rough idea to rewrite / generate from. */
  input: string;
  /**
   * Whether to rewrite an existing prompt ("rewrite") or generate a polished
   * prompt from a rough idea ("generate"). Defaults to "rewrite".
   */
  mode?: EnhancerMode;
  /**
   * Current working directory. Passed through for callers that want to keep
   * request metadata aligned, but not used for context discovery here.
   */
  cwd?: string;
  /** The model used for the final enhancement call. */
  model: Model<Api>;
  /** Resolved API key for the model's provider. */
  apiKey: string;
  /** Optional materialized request headers (e.g. custom provider headers). */
  headers?: Record<string, string>;
  /** Optional abort signal to cancel the model call. */
  signal?: AbortSignal;
  /** If provided, request a materially different alternative from this prior output. */
  previousOutput?: string;
  /** Optional explicit refs gathered by an upstream browse pass. */
  relevantRefs?: Ref[];
}

/** Structured result returned by enhancePrompt(). */
export interface EnhancePromptResult {
  /** The enhanced / generated prompt text produced by the model. */
  enhancedPrompt: string;
  /** Explicit refs that were provided and injected as scoped context. */
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

/**
 * Run the prompt-shaping pipeline:
 *
 *   explicit refs → buildEnhancerPrompt() → makeModelCall()
 *
 * Every model call runs in isolated ephemeral context — no parent session id
 * is forwarded, no conversation history is attached, and only the supplied
 * system prompt + one user message are sent.
 */
export async function enhancePrompt(options: EnhancePromptOptions): Promise<EnhancePromptResult> {
  const {
    input,
    mode = "rewrite",
    model,
    apiKey,
    headers,
    signal,
    previousOutput,
    relevantRefs,
  } = options;

  const refs: Ref[] = relevantRefs ?? [];
  const refPaths = refs.map((r) => r.path);
  const entryPoint = refs.find((r) => r.isEntrypoint)?.path;

  const systemPrompt = buildEnhancerPrompt({
    mode,
    relevantRefs: refPaths.length > 0 ? refPaths : undefined,
    entryPoint,
  });

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
