/**
 * pi-prompt-gen — composed prompt-shaping core.
 *
 * Wires the prompt-builder and isolated final model call together.
 * Repo/context examination now happens outside this file via an isolated
 * read-only browse pass that can provide explicit refs plus bounded git and
 * session context.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { buildEnhancerPrompt, type EnhancerMode, type RelevantRef } from "./enhancer-prompt.js";
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
  /** One-line rationale explaining why this file matters. */
  reason?: string;
  /** Role/context label (e.g. "implementation", "test", "config"). */
  role?: string;
  /** Key symbols defined in this file (bounded list). */
  symbols?: string[];
}

/** Display-oriented ref with rationale metadata for prompt rendering. */
export type { RelevantRef } from "./enhancer-prompt.js";

/** Structured metadata for a single changed file in git context. */
export interface ChangedFileDetail {
  /** Repo-relative path to the changed file. */
  path: string;
  /** Simplified status (modified, added, deleted, renamed, copied, unmerged, unknown). */
  status: string;
  /** Whether the change is staged (in the index). */
  staged: boolean;
  /** Whether the change is unstaged (in the working tree). */
  unstaged: boolean;
  /** Whether the file is untracked. */
  untracked: boolean;
  /** Number of added lines (if available). */
  additions?: number;
  /** Number of deleted lines (if available). */
  deletions?: number;
}

/** Bounded git context selected by the upstream browse scout. */
export interface GitContext {
  /** Current git branch name if the scout found one. */
  branch?: string;
  /** Concise working-tree summary selected by the scout. */
  statusSummary?: string;
  /** Small bounded set of changed files worth referencing in the final prompt. */
  changedFiles?: string[];
  /** Concise diff summary distilled by the scout. */
  diffSummary?: string;
  /** Structured per-file change details with status and compact diffstat (bounded). */
  changedFileDetails?: ChangedFileDetail[];
}

/** One user/assistant message excerpt selected by the browse scout. */
export interface SessionContextMessage {
  role: "user" | "assistant";
  text: string;
}

/** Bounded conversation context selected by the upstream browse scout. */
export interface SessionContext {
  relevantMessages: SessionContextMessage[];
}

/**
 * Bounded run metadata collected during a prompt-enhancement invocation.
 *
 * Every field except `refCount` is optional so the shape is resilient when
 * providers omit usage stats or when latency is not tracked. Metadata never
 * contains raw user input, API keys, full usage objects, or other sensitive
 * or unbounded data.
 */
export interface RunMetadata {
  /** The model identifier that served the response (e.g. "gpt-4o-mini"). */
  modelId?: string;
  /** Human-readable model name. */
  modelName?: string;
  /** Provider name (e.g. "openai"). */
  modelProvider?: string;
  /**
   * Approximate wall-clock latency of the enhancePrompt call in milliseconds.
   * Measured with performance.now() around the model call inside
   * enhancePrompt(), not end-to-end (which would include browse pass).
   */
  latencyMs?: number;
  /** Number of explicit refs bundled into the prompt harness. */
  refCount: number;
  /**
   * Names of the browse tools that were made available to the upstream scout.
   * Populated by the extension layer, not by enhancePrompt() itself.
   */
  browseToolsUsed?: string[];
  /** Why the model stopped generating. */
  stopReason?: string;
  /**
   * Bounded token-usage summary suitable for UI display.
   * Raw Usage objects from the provider can contain cost information;
   * this summary strips cost and preserves only the count values.
   */
  usageSummary?: {
    input?: number;
    output?: number;
    totalTokens?: number;
  };
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
  /** Optional bounded git context gathered by an upstream browse pass. */
  gitContext?: GitContext;
  /** Optional bounded conversation context gathered by an upstream browse pass. */
  sessionContext?: SessionContext;
}

/** Structured result returned by enhancePrompt(). */
export interface EnhancePromptResult {
  /** The enhanced / generated prompt text produced by the model. */
  enhancedPrompt: string;
  /** Explicit refs that were provided and injected as scoped context. */
  refs: Ref[];
  /** Optional bounded git context that was injected into the prompt harness. */
  gitContext?: GitContext;
  /** Optional bounded conversation context that was injected into the prompt harness. */
  sessionContext?: SessionContext;
  /**
   * The complete system prompt that was sent to the model. Includes the
   * role, mode instruction, guardrails, and scoped context only.
   * Raw user input stays in the user message. Useful for debugging.
   */
  systemPrompt: string;
  /** Raw result from the isolated model call (content, usage, stopReason, …). */
  modelResult: ModelCallResult;
  /**
   * Bounded run metadata for observability.
   * Populated by enhancePrompt() with what it can observe (refCount, latency,
   * model info from options, usage summary from modelResult, stopReason).
   * `browseToolsUsed` is set by the extension wrapper layer.
   */
  metadata: RunMetadata;
}

/**
 * Run the prompt-shaping pipeline:
 *
 *   explicit browse context → buildEnhancerPrompt() → makeModelCall()
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
    gitContext,
    sessionContext,
  } = options;

  const refs: Ref[] = relevantRefs ?? [];
  const entryPoint = refs.find((r) => r.isEntrypoint)?.path;

  // Build display refs (path + optional rationale metadata) for the prompt builder
  const displayRefs: RelevantRef[] = [];
  for (const r of refs) {
    const item: RelevantRef = { path: r.path };
    if (r.reason) item.reason = r.reason;
    if (r.role) item.role = r.role;
    if (r.symbols?.length) item.symbols = r.symbols;
    displayRefs.push(item);
  }

  const systemPrompt = buildEnhancerPrompt({
    mode,
    relevantRefs: displayRefs.length > 0 ? displayRefs : undefined,
    entryPoint,
    gitContext,
    sessionContext,
  });

  const startTime = performance.now();
  const modelResult = await makeModelCall({
    model,
    apiKey,
    headers,
    signal,
    systemPrompt,
    userContent: buildUserContent(input, previousOutput),
  });
  const latencyMs = Math.round(performance.now() - startTime);

  const usage = modelResult.usage;
  const usageSummary = usage
    ? {
        input: usage.input,
        output: usage.output,
        totalTokens: usage.totalTokens,
      }
    : undefined;

  return {
    enhancedPrompt: modelResult.content,
    refs,
    gitContext,
    sessionContext,
    systemPrompt,
    modelResult,
    metadata: {
      modelId: model.id,
      modelName: model.name,
      modelProvider: model.provider,
      latencyMs,
      refCount: refs.length,
      stopReason: modelResult.stopReason,
      usageSummary,
    },
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
    "Produce a materially different alternative while preserving the same goal, scope, and level of concision. " +
    "Vary the wording or structure (e.g. compact sections vs. flat paragraph).",
  ].join("\n");
}
