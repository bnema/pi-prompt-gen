/**
 * Focused tests for the extensions/index.ts input hook.
 */

import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

const testPaths = vi.hoisted(() => ({
  agentDir: `/tmp/pi-prompt-gen-extension-input-test-${process.pid}`,
}));

const settingsMocks = vi.hoisted(() => ({
  getEnabledModels: vi.fn<() => string[] | undefined>(),
}));

const mockEnhancePrompt = vi.fn();
const mockBrowseCodebase = vi.fn();
const mockSafeBrowseToolNames = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "code_search",
  "project_memory_read",
  "project_memory_search",
  "codegraph_explore",
  "codegraph_node",
  "codegraph_status",
]);

vi.mock("../src/index.js", () => ({
  enhancePrompt: mockEnhancePrompt,
}));

vi.mock("../src/browse-pass.js", () => ({
  browseCodebase: mockBrowseCodebase,
  SAFE_BROWSE_TOOL_NAMES: mockSafeBrowseToolNames,
}));

vi.mock("../src/modal.js", () => ({
  PromptGenModal: vi.fn().mockImplementation(function PromptGenModalMock() {
    return { bind: vi.fn() };
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  getAgentDir: vi.fn(() => testPaths.agentDir),
  SettingsManager: {
    create: vi.fn(() => ({
      getEnabledModels: settingsMocks.getEnabledModels,
    })),
  },
}));

const { default: registerPiPromptGen } = await import("../extensions/index.js");
const { enhancePrompt } = await import("../src/index.js");
const { browseCodebase } = await import("../src/browse-pass.js");
const { copyToClipboard } = await import("@earendil-works/pi-coding-agent");

const INPUT_CHOICES = ["Yes", "No", "Don't ask again for this session"];
const INPUT_CHOICES_WITH_NO_DEFAULT = ["No", "Yes", "Don't ask again for this session"];

function makeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions" as Api,
    provider: "test-provider",
    baseUrl: "https://api.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 2048,
    ...overrides,
  };
}

function makeMockContext(overrides?: Partial<ExtensionContext>): ExtensionContext {
  const ui = {
    notify: vi.fn(),
    getEditorText: vi.fn().mockReturnValue(""),
    setEditorText: vi.fn(),
    custom: vi.fn(),
    editor: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    setStatus: vi.fn(),
    setWorkingMessage: vi.fn(),
    setWorkingVisible: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    setWidget: vi.fn(),
    setFooter: vi.fn(),
    setHeader: vi.fn(),
    setTitle: vi.fn(),
    pasteToEditor: vi.fn(),
    addAutocompleteProvider: vi.fn(),
    onTerminalInput: vi.fn().mockReturnValue(vi.fn()),
    theme: {
      fg: vi.fn((_color: string, text: string) => text),
    },
  } as unknown as ExtensionUIContext;

  return {
    ui,
    mode: "tui",
    hasUI: true,
    model: makeModel(),
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-test", headers: undefined }),
    } as any,
    cwd: "/test/project",
    isIdle: vi.fn().mockReturnValue(true),
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue(""),
    shutdown: vi.fn(),
    abort: vi.fn(),
    isProjectTrusted: vi.fn().mockReturnValue(true),
    signal: undefined,
    hasPendingMessages: vi.fn().mockReturnValue(false),
    getContextUsage: vi.fn(),
    sessionManager: {
      getBranch: vi.fn().mockReturnValue([]),
      getEntries: vi.fn().mockReturnValue([]),
    } as any,
    ...overrides,
  };
}

function makeExtensionAPI(overrides?: Partial<ExtensionAPI>): ExtensionAPI {
  return {
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([
      { name: "read" },
      { name: "grep" },
      { name: "find" },
      { name: "ls" },
      { name: "code_search" },
      { name: "project_memory_read" },
      { name: "project_memory_search" },
      { name: "codegraph_explore" },
      { name: "codegraph_node" },
      { name: "codegraph_status" },
      { name: "write" },
    ]),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerShortcut: vi.fn(),
    ...overrides,
  } as unknown as ExtensionAPI;
}

function getRegisteredInputHandler(
  pi: ExtensionAPI,
): (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult | void> | InputEventResult | void {
  const call = (pi.on as ReturnType<typeof vi.fn>).mock.calls.find(
    (entry: unknown[]) => entry[0] === "input",
  );
  if (!call) throw new Error("input handler was not registered");
  return call[1] as (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult | void> | InputEventResult | void;
}

function getRegisteredSessionStartHandler(
  pi: ExtensionAPI,
): (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void> {
  const call = (pi.on as ReturnType<typeof vi.fn>).mock.calls.find(
    (entry: unknown[]) => entry[0] === "session_start",
  );
  if (!call) throw new Error("session_start handler was not registered");
  return call[1] as (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>;
}

function makeInputEvent(overrides?: Partial<InputEvent>): InputEvent {
  return {
    type: "input",
    text: "make this prompt better",
    source: "interactive",
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(testPaths.agentDir, { recursive: true, force: true });
  vi.clearAllMocks();
  settingsMocks.getEnabledModels.mockReturnValue(undefined);
  mockBrowseCodebase.mockResolvedValue({
    refs: [],
    gitContext: undefined,
    sessionContext: undefined,
  });
  mockEnhancePrompt.mockResolvedValue({
    enhancedPrompt: "Enhanced result text",
    refs: [],
    gitContext: undefined,
    sessionContext: undefined,
    systemPrompt: "",
    modelResult: { content: "Enhanced result text", stopReason: "stop" },
    metadata: {
      modelId: "test-model",
      modelName: "Test Model",
      modelProvider: "test-provider",
      latencyMs: 500,
      refCount: 0,
      stopReason: "stop",
    },
  });
});

describe("Input hook — prompt confirmation", () => {
  it("asks before enhancing normal outgoing messages", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("No"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const result = await inputHandler(makeInputEvent({ text: "normal user prompt" }), ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith("Would you like to enhance this prompt?", INPUT_CHOICES);
    expect(result).toEqual({ action: "continue" });
  });

  it("continues with the original message unchanged when the user selects No", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("No"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const result = await inputHandler(makeInputEvent({ text: "ship the original" }), ctx);

    expect(result).toEqual({ action: "continue" });
    expect(browseCodebase).not.toHaveBeenCalled();
    expect(enhancePrompt).not.toHaveBeenCalled();
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });

  it("defaults to No on the next input confirmation after the user selects No", async () => {
    const select = vi.fn().mockResolvedValue("No");
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select,
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);

    await inputHandler(makeInputEvent({ text: "first original" }), ctx);
    await inputHandler(makeInputEvent({ text: "second original" }), ctx);

    expect(select).toHaveBeenNthCalledWith(1, "Would you like to enhance this prompt?", INPUT_CHOICES);
    expect(select).toHaveBeenNthCalledWith(2, "Would you like to enhance this prompt?", INPUT_CHOICES_WITH_NO_DEFAULT);
  });

  it("still allows choosing Yes when No is the session default", async () => {
    const select = vi.fn()
      .mockResolvedValueOnce("No")
      .mockResolvedValueOnce("Yes");
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select,
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);

    await inputHandler(makeInputEvent({ text: "first original" }), ctx);
    const result = await inputHandler(makeInputEvent({ text: "enhance second prompt" }), ctx);

    expect(select).toHaveBeenNthCalledWith(2, "Would you like to enhance this prompt?", INPUT_CHOICES_WITH_NO_DEFAULT);
    expect(result).toEqual({ action: "transform", text: "Enhanced result text" });
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "enhance second prompt",
      mode: "rewrite",
    }));
  });

  it("resets the remembered No default on session_start", async () => {
    const select = vi.fn().mockResolvedValue("No");
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select,
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const sessionStartHandler = getRegisteredSessionStartHandler(pi);

    await inputHandler(makeInputEvent({ text: "first original" }), ctx);
    await inputHandler(makeInputEvent({ text: "second original" }), ctx);
    await sessionStartHandler({ type: "session_start", reason: "new" }, ctx);
    await inputHandler(makeInputEvent({ text: "third original" }), ctx);

    expect(select).toHaveBeenNthCalledWith(1, "Would you like to enhance this prompt?", INPUT_CHOICES);
    expect(select).toHaveBeenNthCalledWith(2, "Would you like to enhance this prompt?", INPUT_CHOICES_WITH_NO_DEFAULT);
    expect(select).toHaveBeenNthCalledWith(3, "Would you like to enhance this prompt?", INPUT_CHOICES);
  });

  it("enhances and uses the enhanced prompt when the user selects Yes", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("Yes"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const result = await inputHandler(makeInputEvent({ text: "make this clear" }), ctx);

    expect(result).toEqual({ action: "transform", text: "Enhanced result text" });
    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      input: "make this clear",
      cwd: "/test/project",
    }));
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "make this clear",
      mode: "rewrite",
    }));
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith("make this clear");
    expect(copyToClipboard).not.toHaveBeenCalledWith("Enhanced result text");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalledWith("Enhanced result text");
  });

  it("handles Escape during browse by aborting, restoring original input, and not sending stale text", async () => {
    let resolveBrowse!: (value: { refs: [] }) => void;
    const browsePromise = new Promise<{ refs: [] }>((resolve) => {
      resolveBrowse = resolve;
    });
    mockBrowseCodebase.mockReturnValueOnce(browsePromise);

    const unsubscribe = vi.fn();
    const ui = {
      ...makeMockContext().ui,
      select: vi.fn().mockResolvedValue("Yes"),
      onTerminalInput: vi.fn().mockReturnValue(unsubscribe),
    } as ExtensionUIContext;
    const ctx = makeMockContext({ ui });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const resultPromise = inputHandler(makeInputEvent({ text: "exact original sentence" }), ctx);

    await vi.waitFor(() => {
      expect(ctx.ui.onTerminalInput).toHaveBeenCalledTimes(1);
      expect(browseCodebase).toHaveBeenCalledTimes(1);
    });

    const browseSignal = (browseCodebase as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].signal as AbortSignal;
    const terminalHandler = (ctx.ui.onTerminalInput as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as (data: string) => { consume?: boolean } | undefined;
    expect(terminalHandler("x")).toBeUndefined();
    expect(terminalHandler("\u001b")).toEqual({ consume: true });

    const result = await resultPromise;
    expect(result).toEqual({ action: "handled" });
    expect(browseSignal.aborted).toBe(true);
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("exact original sentence");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Enhancement cancelled; restored original prompt.",
      "info",
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-prompt-gen", undefined);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    resolveBrowse({ refs: [] });
    await Promise.resolve();
    expect(enhancePrompt).not.toHaveBeenCalled();
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith("exact original sentence");
    expect(copyToClipboard).not.toHaveBeenCalledWith("Enhanced result text");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalledWith("Enhanced result text");
  });

  it("warns and still cancels when restoring original input fails", async () => {
    let resolveBrowse!: (value: { refs: [] }) => void;
    mockBrowseCodebase.mockReturnValueOnce(new Promise<{ refs: [] }>((resolve) => {
      resolveBrowse = resolve;
    }));

    const unsubscribe = vi.fn();
    const ui = {
      ...makeMockContext().ui,
      select: vi.fn().mockResolvedValue("Yes"),
      onTerminalInput: vi.fn().mockReturnValue(unsubscribe),
      setEditorText: vi.fn(() => {
        throw new Error("editor restore failed");
      }),
    } as ExtensionUIContext;
    const ctx = makeMockContext({ ui });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const resultPromise = inputHandler(makeInputEvent({ text: "restore fallback prompt" }), ctx);

    await vi.waitFor(() => {
      expect(ctx.ui.onTerminalInput).toHaveBeenCalledTimes(1);
      expect(browseCodebase).toHaveBeenCalledTimes(1);
    });

    const terminalHandler = (ctx.ui.onTerminalInput as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as (data: string) => { consume?: boolean } | undefined;
    expect(() => terminalHandler("\u001b")).not.toThrow();

    const result = await resultPromise;
    expect(result).toEqual({ action: "handled" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Enhancement cancelled, but failed to restore original prompt. The original prompt was copied to clipboard before enhancement.",
      "warning",
    );

    resolveBrowse({ refs: [] });
    await Promise.resolve();
    expect(enhancePrompt).not.toHaveBeenCalled();
  });

  it("ignores a stale enhancement result that resolves after Escape cancellation", async () => {
    let resolveEnhance!: (value: Awaited<ReturnType<typeof mockEnhancePrompt>>) => void;
    mockEnhancePrompt.mockReturnValueOnce(new Promise((resolve) => {
      resolveEnhance = resolve;
    }));

    const ui = {
      ...makeMockContext().ui,
      select: vi.fn().mockResolvedValue("Yes"),
    } as ExtensionUIContext;
    const ctx = makeMockContext({ ui });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const resultPromise = inputHandler(makeInputEvent({ text: "original that should remain" }), ctx);

    await vi.waitFor(() => {
      expect(enhancePrompt).toHaveBeenCalledTimes(1);
    });

    const enhanceSignal = (enhancePrompt as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].signal as AbortSignal;
    const terminalHandler = (ctx.ui.onTerminalInput as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as (data: string) => { consume?: boolean } | undefined;
    expect(terminalHandler("\u001b")).toEqual({ consume: true });

    const result = await resultPromise;
    expect(result).toEqual({ action: "handled" });
    expect(enhanceSignal.aborted).toBe(true);

    resolveEnhance({
      enhancedPrompt: "late enhanced text",
      refs: [],
      gitContext: undefined,
      sessionContext: undefined,
      systemPrompt: "",
      modelResult: { content: "late enhanced text", stopReason: "stop" },
      metadata: {
        modelId: "test-model",
        modelName: "Test Model",
        modelProvider: "test-provider",
        latencyMs: 500,
        refCount: 0,
        stopReason: "stop",
      },
    });
    await Promise.resolve();

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith("original that should remain");
    expect(copyToClipboard).not.toHaveBeenCalledWith("late enhanced text");
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("original that should remain");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalledWith("late enhanced text");
  });

  it("continues unchanged and suppresses future prompts when the user selects Don't ask again for this session", async () => {
    const select = vi.fn().mockResolvedValue("Don't ask again for this session");
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select,
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const firstResult = await inputHandler(makeInputEvent({ text: "first original" }), ctx);
    const secondResult = await inputHandler(makeInputEvent({ text: "second original" }), ctx);

    expect(firstResult).toEqual({ action: "continue" });
    expect(secondResult).toEqual({ action: "continue" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(browseCodebase).not.toHaveBeenCalled();
    expect(enhancePrompt).not.toHaveBeenCalled();
  });

  it("resets the don't-ask-again choice on session_start", async () => {
    const select = vi.fn()
      .mockResolvedValueOnce("Don't ask again for this session")
      .mockResolvedValueOnce("No");
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select,
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const sessionStartHandler = getRegisteredSessionStartHandler(pi);

    await inputHandler(makeInputEvent({ text: "first original" }), ctx);
    await inputHandler(makeInputEvent({ text: "second original" }), ctx);
    await sessionStartHandler({ type: "session_start", reason: "new" }, ctx);
    const result = await inputHandler(makeInputEvent({ text: "third original" }), ctx);

    expect(result).toEqual({ action: "continue" });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("does not intercept streaming steer or follow-up messages", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("Yes"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const steerResult = await inputHandler(makeInputEvent({ text: "steer", streamingBehavior: "steer" }), ctx);
    const followUpResult = await inputHandler(makeInputEvent({ text: "follow-up", streamingBehavior: "followUp" }), ctx);

    expect(steerResult).toEqual({ action: "continue" });
    expect(followUpResult).toEqual({ action: "continue" });
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(enhancePrompt).not.toHaveBeenCalled();
  });

  it("does not intercept extension-generated messages", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("Yes"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const result = await inputHandler(makeInputEvent({
      text: "enhanced prompt from extension",
      source: "extension",
    }), ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(enhancePrompt).not.toHaveBeenCalled();
  });

  it("does not intercept slash commands before Pi expands them", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("Yes"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const result = await inputHandler(makeInputEvent({ text: "/skill:example" }), ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(enhancePrompt).not.toHaveBeenCalled();
  });
});
