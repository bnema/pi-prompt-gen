/**
 * Tests for src/index.ts — composed enhancePrompt() pipeline.
 *
 * Covers:
 * - Pipeline wiring: findRefs → buildEnhancerPrompt → makeModelCall
 * - Isolated ephemeral context (no session history leaked)
 * - Structure of the returned EnhancePromptResult
 * - Skip ref-finding when cwd is not provided
 * - Model call is invoked with the correct system prompt and user content
 * - Refs are passed as context when cwd is provided
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileSystem } from "../src/ref-finder.js";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ModelCallParams, ModelCallResult } from "../src/model-call.js";

// Mock the model-call module to avoid real API calls
const mockMakeModelCall = vi.fn<(params: ModelCallParams) => Promise<ModelCallResult>>();

vi.mock("../src/model-call.js", () => ({
  makeModelCall: mockMakeModelCall,
}));

// Import *after* mocking
const { enhancePrompt } = await import("../src/index.js");
import type { EnhancePromptOptions } from "../src/index.js";

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

function makeBasicOptions(overrides?: Partial<EnhancePromptOptions>): EnhancePromptOptions {
  return {
    input: "fix the sidebar sort order",
    model: makeFakeModel(),
    apiKey: "sk-test-key",
    ...overrides,
  };
}

/** A deterministic in-memory FileSystem for ref-finder injection. */
function makeFs(files: Record<string, { lines: string[]; exists: boolean }>, repoRoot?: string): FileSystem {
  return {
    async lsRecursive(_dir: string): Promise<string[]> {
      return Object.keys(files)
        .filter((f) => files[f].exists)
        .sort();
    },
    async readHead(filePath: string, n: number): Promise<string[]> {
      const entry = files[filePath];
      if (!entry || !entry.exists) return [];
      return entry.lines.slice(0, Math.max(0, n));
    },
    async lineCount(filePath: string): Promise<number> {
      const entry = files[filePath];
      if (!entry || !entry.exists) return 0;
      return entry.lines.length;
    },
    async getRepoRoot(_dir: string): Promise<string | undefined> {
      return repoRoot;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enhancePrompt (composed core path)", () => {
  beforeEach(() => {
    mockMakeModelCall.mockReset();
    mockMakeModelCall.mockResolvedValue({
      content: "Refine the sidebar component sort order to use `createdAt` descending.",
      usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 80, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      responseModel: "test-model",
      responseId: "resp_test",
    });
  });

  it("returns a structured EnhancePromptResult with enhancedPrompt, refs, systemPrompt, modelResult", async () => {
    const result = await enhancePrompt(makeBasicOptions());

    expect(result).toHaveProperty("enhancedPrompt");
    expect(typeof result.enhancedPrompt).toBe("string");
    expect(result).toHaveProperty("refs");
    expect(Array.isArray(result.refs)).toBe(true);
    expect(result).toHaveProperty("systemPrompt");
    expect(typeof result.systemPrompt).toBe("string");
    expect(result).toHaveProperty("modelResult");
    expect(result.modelResult).toHaveProperty("content");
    expect(result.modelResult).toHaveProperty("usage");
    expect(result.modelResult).toHaveProperty("stopReason");
  });

  it("calls makeModelCall with the supplied model and apiKey", async () => {
    const model = makeFakeModel();
    await enhancePrompt(makeBasicOptions({ model, apiKey: "sk-custom" }));

    expect(mockMakeModelCall).toHaveBeenCalledTimes(1);
    const params = mockMakeModelCall.mock.calls[0][0] as { model: Model<Api>; apiKey: string };
    expect(params.model).toBe(model);
    expect(params.apiKey).toBe("sk-custom");
  });

  it("passes the buildEnhancerPrompt output as systemPrompt to makeModelCall", async () => {
    await enhancePrompt(makeBasicOptions({ input: "test input" }));

    const params = mockMakeModelCall.mock.calls[0][0] as { systemPrompt: string };
    expect(params.systemPrompt).toContain("# Role");
    expect(params.systemPrompt).toContain("Improve the following prompt");
  });

  it("uses rewrite mode by default", async () => {
    await enhancePrompt(makeBasicOptions());

    const params = mockMakeModelCall.mock.calls[0][0] as { systemPrompt: string };
    expect(params.systemPrompt).toContain("Improve the following prompt");
    expect(params.systemPrompt).not.toContain("Turn this rough idea");
  });

  it("uses generate mode when mode='generate'", async () => {
    await enhancePrompt(makeBasicOptions({ mode: "generate" }));

    const params = mockMakeModelCall.mock.calls[0][0] as { systemPrompt: string };
    expect(params.systemPrompt).toContain("Turn this rough idea");
    expect(params.systemPrompt).not.toContain("Improve the following prompt");
  });

  it("sends userContent equal to the input", async () => {
    await enhancePrompt(makeBasicOptions({ input: "make the button blue" }));

    const params = mockMakeModelCall.mock.calls[0][0] as { userContent: string };
    expect(params.userContent).toBe("make the button blue");
  });

  it("adds previous output as a regenerate hint when provided", async () => {
    await enhancePrompt(makeBasicOptions({
      input: "make the button blue",
      previousOutput: "Previous polished prompt",
    }));

    const params = mockMakeModelCall.mock.calls[0][0] as { userContent: string };
    expect(params.userContent).toContain("make the button blue");
    expect(params.userContent).toContain("Previous draft to avoid repeating verbatim:");
    expect(params.userContent).toContain("Previous polished prompt");
    expect(params.userContent).toContain("Produce a materially different alternative");
  });

  it("passes headers and signal through to makeModelCall", async () => {
    const signal = new AbortController().signal;
    const headers = { "X-Custom": "value" };

    await enhancePrompt(makeBasicOptions({ headers, signal }));

    const params = mockMakeModelCall.mock.calls[0][0] as { headers?: Record<string, string>; signal?: AbortSignal };
    expect(params.headers).toEqual(headers);
    expect(params.signal).toBe(signal);
  });

  it("returns an empty refs array when cwd is not provided", async () => {
    const result = await enhancePrompt(makeBasicOptions({ cwd: undefined }));
    expect(result.refs).toEqual([]);
  });

  it("collects file refs when cwd is provided (via injectable fs)", async () => {
    const fs = makeFs({
      "/project/src/main.ts": {
        lines: ["// main entry point"],
        exists: true,
      },
      "/project/src/sidebar.ts": {
        lines: ["// sidebar sort logic", "function sortByDate() {}"],
        exists: true,
      },
    }, "/project");

    const result = await enhancePrompt(makeBasicOptions({
      input: "fix the sidebar sort order by date",
      cwd: "/project",
      fs,
    }));

    expect(result.refs.length).toBeGreaterThan(0);
    // At least one ref should have a path containing "sidebar"
    const sidebarRef = result.refs.find((r) => r.path.includes("sidebar"));
    expect(sidebarRef).toBeDefined();
    expect(sidebarRef!.path).toBe("src/sidebar.ts");
    expect(sidebarRef!.score).toBeGreaterThan(0);
    expect(typeof sidebarRef!.isEntrypoint).toBe("boolean");
    expect(sidebarRef!.lineCount).toBeGreaterThan(0);
  });

  it("includes ref paths as context in the system prompt when refs are found", async () => {
    const fs = makeFs({
      "/project/main.ts": {
        lines: ["// main entry"],
        exists: true,
      },
      "/project/sidebar.ts": {
        lines: ["// sidebar", "sort"],
        exists: true,
      },
    }, "/project");

    const result = await enhancePrompt(makeBasicOptions({
      input: "sidebar sort",
      cwd: "/project",
      fs,
    }));

    expect(result.systemPrompt).toContain("sidebar.ts");
    expect(result.systemPrompt).toContain("## Context");
  });

  it("does NOT include context section in the system prompt when no refs found", async () => {
    const result = await enhancePrompt(makeBasicOptions({ cwd: undefined }));
    expect(result.systemPrompt).not.toContain("## Context");
  });

  it("includes anti-debug and anti-essay guardrails in the system prompt", async () => {
    const result = await enhancePrompt(makeBasicOptions({
      input: "debug why the form crashes on submit",
    }));

    expect(result.systemPrompt).toContain("NEVER debug, investigate, pinpoint root causes");
    expect(result.systemPrompt).toContain("RESIST essay-length output");
    expect(result.systemPrompt).toContain("You do NOT implement code");
    expect(result.systemPrompt).toContain("SCOPE LOCK");
    expect(result.systemPrompt).toContain("CHANGE BUDGET");
  });

  it("uses the enhanced content from the model call as enhancedPrompt in the result", async () => {
    const result = await enhancePrompt(makeBasicOptions());
    expect(result.enhancedPrompt).toBe(
      "Refine the sidebar component sort order to use `createdAt` descending.",
    );
  });

  it("propagates modelResult fields (usage, stopReason, responseModel, responseId)", async () => {
    const result = await enhancePrompt(makeBasicOptions());

    expect(result.modelResult.usage).toBeDefined();
    expect(result.modelResult.usage!.input).toBe(50);
    expect(result.modelResult.usage!.output).toBe(30);
    expect(result.modelResult.stopReason).toBe("stop");
    expect(result.modelResult.responseModel).toBe("test-model");
    expect(result.modelResult.responseId).toBe("resp_test");
  });

  it("does NOT reference session history or parent session id — only the supplied messages are sent", async () => {
    await enhancePrompt(makeBasicOptions());

    const params = mockMakeModelCall.mock.calls[0][0] as { systemPrompt: string; userContent: string };
    // Only one user message with the input — no history, no extra messages
    expect(params.userContent).toBeDefined();
    expect(params.systemPrompt).not.toContain("## User Input");
    // No session-related fields in the params
    expect(params).not.toHaveProperty("sessionId");
  });

  it("system prompt does not contain the raw user input (policy/harness only)", async () => {
    await enhancePrompt(makeBasicOptions({ input: "fix the sidebar sort order" }));

    const params = mockMakeModelCall.mock.calls[0][0] as { systemPrompt: string };
    expect(params.systemPrompt).not.toContain("fix the sidebar sort order");
  });
});
