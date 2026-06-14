/**
 * Tests for model-call.ts — isolated model-call helper.
 *
 * Covers:
 * - makeModelCall accepts params without session history / session manager
 * - Content is concatenated from text blocks in the response
 * - Usage, stopReason, responseModel, responseId are passed through
 * - Errors propagate as exceptions
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AssistantMessage,
  Context,
  ProviderStreamOptions,
  Model,
  Api,
  Usage,
  StopReason,
} from "@earendil-works/pi-ai";

// Mock the pi-ai module completely
const mockComplete = vi.fn<
  (model: unknown, context: Context, options?: ProviderStreamOptions) => Promise<AssistantMessage>
>();

vi.mock("@earendil-works/pi-ai", () => ({
  complete: mockComplete,
}));

// Import *after* mocking
const { makeModelCall } = await import("../src/model-call.js");
import type { ModelCallParams } from "../src/model-call.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeModel(): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions" as Api,
    provider: "openai",
    baseUrl: "https://api.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 2048,
  };
}

function makeBasicParams(overrides?: Partial<ModelCallParams>): ModelCallParams {
  return {
    model: makeFakeModel(),
    apiKey: "sk-test-key",
    userContent: "write a test",
    ...overrides,
  };
}

function makeAssistantMessage(
  overrides?: Partial<AssistantMessage>,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello world" }],
    api: "openai-completions" as Api,
    provider: "openai",
    model: "test-model",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as StopReason,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeModelCall", () => {
  beforeEach(() => {
    mockComplete.mockReset();
  });

  it("calls complete with the model, systemPrompt, user message, and options", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage());

    const model = makeFakeModel();
    await makeModelCall({
      model,
      apiKey: "sk-test",
      systemPrompt: "You are a helpful assistant.",
      userContent: "write a poem",
      headers: { "X-Custom": "value" },
      signal: new AbortController().signal,
    });

    expect(mockComplete).toHaveBeenCalledTimes(1);

    const [calledModel, ctx, opts] = mockComplete.mock.calls[0] as [
      Model<Api>,
      Context,
      ProviderStreamOptions | undefined,
    ];
    // Model reference should be the same object
    expect(calledModel).toBe(model);
    // System prompt should go through
    expect(ctx).toHaveProperty("systemPrompt", "You are a helpful assistant.");
    // Messages array should have one user message with the content
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "write a poem" }],
    });
    // Options should include apiKey, headers, signal
    expect(opts).toMatchObject({
      apiKey: "sk-test",
      headers: { "X-Custom": "value" },
    });
  });

  it("does NOT require or reference session history or session manager", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage());

    const result = await makeModelCall(makeBasicParams());

    // The mock was called — session-agnostic check: only one message was sent
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [, ctx] = mockComplete.mock.calls[0] as [unknown, Context];
    expect(ctx.messages).toHaveLength(1);
    // No assistant messages, no tool results, no history
    expect(ctx.messages.every((m) => m.role === "user")).toBe(true);
    expect(result).toBeDefined();
  });

  it("concatenates text from multiple text content blocks", async () => {
    mockComplete.mockResolvedValue(
      makeAssistantMessage({
        content: [
          { type: "text", text: "First block. " },
          { type: "text", text: "Second block." },
        ],
      }),
    );

    const result = await makeModelCall(makeBasicParams());
    expect(result.content).toBe("First block. \nSecond block.");
  });

  it("passes through usage, stopReason, responseModel, and responseId", async () => {
    const usage: Usage = {
      input: 5,
      output: 15,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 21,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    mockComplete.mockResolvedValue(
      makeAssistantMessage({
        usage,
        stopReason: "length" as StopReason,
        responseModel: "gpt-4o-mini",
        responseId: "resp_abc123",
      }),
    );

    const result = await makeModelCall(makeBasicParams());

    expect(result.usage).toEqual(usage);
    expect(result.stopReason).toBe("length");
    expect(result.responseModel).toBe("gpt-4o-mini");
    expect(result.responseId).toBe("resp_abc123");
  });

  it("passes through stopReason 'error' for completed-but-failed responses", async () => {
    mockComplete.mockResolvedValue(
      makeAssistantMessage({
        stopReason: "error" as StopReason,
        content: [{ type: "text", text: "I'm sorry, I can't do that." }],
      }),
    );

    const result = await makeModelCall(makeBasicParams());
    expect(result.stopReason).toBe("error");
    expect(result.content).toBe("I'm sorry, I can't do that.");
  });

  it("propagates exceptions from complete", async () => {
    mockComplete.mockRejectedValue(new Error("API key rejected"));

    await expect(makeModelCall(makeBasicParams())).rejects.toThrow(
      "API key rejected",
    );
  });

  it("works without a systemPrompt", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage());

    const result = await makeModelCall(makeBasicParams({ systemPrompt: undefined }));
    expect(result.content).toBe("Hello world");
    // No system prompt in context
    const [, ctx] = mockComplete.mock.calls[0] as [unknown, Context];
    expect(ctx.systemPrompt).toBeUndefined();
  });

  it("works without optional headers or signal", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage());

    const result = await makeModelCall(
      makeBasicParams({ headers: undefined, signal: undefined }),
    );
    expect(result.content).toBe("Hello world");
  });

  it("filters out non-text content blocks", async () => {
    mockComplete.mockResolvedValue(
      makeAssistantMessage({
        content: [
          { type: "text", text: "Visible" },
          { type: "thinking" as any, thinking: "Hidden thoughts" },
          { type: "text", text: "Also visible" },
        ] as any[],
      }),
    );

    const result = await makeModelCall(makeBasicParams());
    // The "thinking" block should be filtered out
    expect(result.content).toBe("Visible\nAlso visible");
    expect(result.content).not.toContain("Hidden thoughts");
  });
});
