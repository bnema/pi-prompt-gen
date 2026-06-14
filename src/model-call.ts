/**
 * Isolated model-call helper for pi-prompt-gen.
 *
 * Provides an injectable function that makes a single turn to the active LLM
 * with explicit system/user content only — no session history, no parent
 * conversation ids, and no dependency on sessionManager.
 */

import { complete, type Api, type Message, type Model, type StopReason, type Usage } from "@earendil-works/pi-ai";

/**
 * Parameters for an isolated model call.
 *
 * All values are explicit — the caller provides the model reference, resolved
 * auth credentials, an optional abort signal, and the system/user content.
 * Nothing is looked up from a session or derived from conversation history.
 */
export interface ModelCallParams {
	/** The model to call (typically the currently active Pi model). */
	model: Model<Api>;
	/** Resolved API key for the model's provider. */
	apiKey: string;
	/** Optional materialized request headers (e.g. custom provider headers). */
	headers?: Record<string, string>;
	/** Optional abort signal to cancel the request. */
	signal?: AbortSignal;
	/** System prompt guiding the model's behavior for this call. */
	systemPrompt?: string;
	/** The user-visible content to send (e.g. the prompt to rewrite). */
	userContent: string;
}

/**
 * Result of a successful isolated model call.
 *
 * Contains the extracted text response together with metadata that
 * orchestration or UI code can use for display, telemetry, or error handling.
 */
export interface ModelCallResult {
	/** Concatenated text content from the model response. */
	content: string;
	/** Token usage reported by the provider, if available. */
	usage?: Usage;
	/** Why the model stopped generating. */
	stopReason: StopReason;
	/** The model identifier that actually served the response (set by some providers). */
	responseModel?: string;
	/** Provider-specific response identifier for tracing. */
	responseId?: string;
}

/**
 * Make a single, isolated call to the given model.
 *
 * This is the sole model-call primitive in pi-prompt-gen. It:
 * - Reuses the caller-supplied model (no separate model config).
 * - Sends only the supplied system prompt and user message — no history.
 * - Returns a plain result shape that downstream code can consume without
 *   reaching into SDK types.
 *
 * Errors (network failures, auth rejections, etc.) propagate as exceptions.
 * Callers should handle `stopReason` values of `"error"` or `"aborted"` to
 * distinguish completed-but-failed responses from transport-level failures.
 */
export async function makeModelCall(params: ModelCallParams): Promise<ModelCallResult> {
	const { model, apiKey, headers, signal, systemPrompt, userContent } = params;

	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userContent }],
			timestamp: Date.now(),
		},
	];

	const response = await complete(
		model,
		{ systemPrompt, messages },
		{ apiKey, headers, signal },
	);

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return {
		content: textContent,
		usage: response.usage,
		stopReason: response.stopReason,
		responseModel: response.responseModel,
		responseId: response.responseId,
	};
}
