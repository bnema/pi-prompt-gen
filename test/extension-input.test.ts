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

function getRegisteredHandler(
  pi: ExtensionAPI,
  eventName: string,
): (event: Record<string, unknown>, ctx: ExtensionContext) => void | Promise<void> {
  const call = (pi.on as ReturnType<typeof vi.fn>).mock.calls.find(
    (entry: unknown[]) => entry[0] === eventName,
  );
  if (!call) throw new Error(`${eventName} handler was not registered`);
  return call[1] as (event: Record<string, unknown>, ctx: ExtensionContext) => void | Promise<void>;
}

function makeInputEvent(overrides?: Partial<InputEvent>): InputEvent {
  return {
    type: "input",
    text: "make this prompt better",
    source: "interactive",
    ...overrides,
  };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeLateEnhanceResult(): Awaited<ReturnType<typeof mockEnhancePrompt>> {
  return {
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

  it("does not prompt while the session is busy compacting or processing another turn", async () => {
    const ctx = makeMockContext({
      isIdle: vi.fn().mockReturnValue(false),
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("No"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const result = await inputHandler(makeInputEvent({ text: "follow up while compacting" }), ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(enhancePrompt).not.toHaveBeenCalled();
  });

  it("does not prompt while compaction lifecycle events are active", async () => {
    const ctx = makeMockContext({
      isIdle: vi.fn().mockReturnValue(true),
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("No"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const compactionStart = getRegisteredHandler(pi, "auto_compaction_start");
    const compactionEnd = getRegisteredHandler(pi, "auto_compaction_end");

    await compactionStart({ type: "auto_compaction_start", reason: "idle", action: "snapcompact" }, ctx);
    const skipped = await inputHandler(makeInputEvent({ text: "queued while compacting" }), ctx);

    expect(skipped).toEqual({ action: "continue" });
    expect(ctx.ui.select).not.toHaveBeenCalled();

    await compactionEnd({
      type: "auto_compaction_end",
      action: "snapcompact",
      result: undefined,
      aborted: false,
      willRetry: false,
    }, ctx);
    const afterCompaction = await inputHandler(makeInputEvent({ text: "normal prompt after compacting" }), ctx);

    expect(afterCompaction).toEqual({ action: "continue" });
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it("does not prompt between manual compaction lifecycle events", async () => {
    const ctx = makeMockContext({
      isIdle: vi.fn().mockReturnValue(true),
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("No"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const compactionStart = getRegisteredHandler(pi, "session_before_compact");
    const compactionEnd = getRegisteredHandler(pi, "session_compact");

    await compactionStart({
      type: "session_before_compact",
      preparation: {},
      branchEntries: [],
      signal: new AbortController().signal,
    }, ctx);
    const skipped = await inputHandler(makeInputEvent({ text: "queued during manual compact" }), ctx);

    expect(skipped).toEqual({ action: "continue" });
    expect(ctx.ui.select).not.toHaveBeenCalled();

    await compactionEnd({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);
    await inputHandler(makeInputEvent({ text: "normal prompt after manual compact" }), ctx);

    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it("keeps skipping prompts until overlapping auto and manual compactions have both ended", async () => {
    const ctx = makeMockContext({
      isIdle: vi.fn().mockReturnValue(true),
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("No"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const autoStart = getRegisteredHandler(pi, "auto_compaction_start");
    const autoEnd = getRegisteredHandler(pi, "auto_compaction_end");
    const manualStart = getRegisteredHandler(pi, "session_before_compact");
    const manualEnd = getRegisteredHandler(pi, "session_compact");

    await autoStart({ type: "auto_compaction_start", reason: "idle", action: "snapcompact" }, ctx);
    await manualStart({
      type: "session_before_compact",
      preparation: {},
      branchEntries: [],
      signal: new AbortController().signal,
    }, ctx);
    await autoEnd({
      type: "auto_compaction_end",
      action: "snapcompact",
      result: undefined,
      aborted: false,
      willRetry: false,
    }, ctx);
    const stillSkipped = await inputHandler(makeInputEvent({ text: "still compacting manually" }), ctx);

    expect(stillSkipped).toEqual({ action: "continue" });
    expect(ctx.ui.select).not.toHaveBeenCalled();

    await manualEnd({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);
    await inputHandler(makeInputEvent({ text: "normal prompt after both compactions" }), ctx);

    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it("re-enables prompting when manual compaction is aborted", async () => {
    const controller = new AbortController();
    const ctx = makeMockContext({
      isIdle: vi.fn().mockReturnValue(true),
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("No"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const compactionStart = getRegisteredHandler(pi, "session_before_compact");

    await compactionStart({
      type: "session_before_compact",
      preparation: {},
      branchEntries: [],
      signal: controller.signal,
    }, ctx);
    const skipped = await inputHandler(makeInputEvent({ text: "queued before aborted compact" }), ctx);
    controller.abort();
    await inputHandler(makeInputEvent({ text: "prompt after aborted compact" }), ctx);

    expect(skipped).toEqual({ action: "continue" });
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
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
    expect(result).toMatchObject({ action: "handled", handled: true });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("Enhanced result text");
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

  it("enhances and resurfaces the enhanced prompt in the editor when the user selects Yes", async () => {
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

    expect(result).toMatchObject({ action: "handled", handled: true });
    expect(browseCodebase).not.toHaveBeenCalled();
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "make this clear",
      mode: "rewrite",
    }));
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith("make this clear");
    expect(copyToClipboard).not.toHaveBeenCalledWith("Enhanced result text");
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("Enhanced result text");
  });

  it("uses #browse in outgoing user text as a repo browsing opt-in", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("Yes"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const result = await inputHandler(makeInputEvent({ text: "make this clear #browse" }), ctx);

    expect(result).toMatchObject({ action: "handled", handled: true });
    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      input: "make this clear #browse",
      cwd: "/test/project",
    }));
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "make this clear #browse",
      mode: "rewrite",
    }));
  });

  it("reapplies enhanced text after OMP clears a handled input draft", async () => {
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
    ctx.ui.setEditorText("");
    await flushAsyncWork();

    expect(result).toMatchObject({ action: "handled", handled: true });
    expect(ctx.ui.setEditorText).toHaveBeenLastCalledWith("Enhanced result text");
  });

  it("does not ask to enhance the next submitted resurfaced prompt", async () => {
    const select = vi.fn().mockResolvedValue("Yes");
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select,
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const firstResult = await inputHandler(makeInputEvent({ text: "make this clear" }), ctx);
    const secondResult = await inputHandler(makeInputEvent({ text: "Enhanced result text" }), ctx);

    expect(firstResult).toMatchObject({ action: "handled", handled: true });
    expect(secondResult).toEqual({ action: "continue" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(enhancePrompt).toHaveBeenCalledTimes(1);
  });

  it("restores the original input instead of transforming to an empty enhanced prompt", async () => {
    mockEnhancePrompt.mockResolvedValueOnce({
      enhancedPrompt: "   ",
      refs: [],
      gitContext: undefined,
      sessionContext: undefined,
      systemPrompt: "",
      modelResult: { content: "   ", stopReason: "stop" },
      metadata: {
        modelId: "test-model",
        modelName: "Test Model",
        modelProvider: "test-provider",
        latencyMs: 500,
        refCount: 0,
        stopReason: "stop",
      },
    });
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        select: vi.fn().mockResolvedValue("Yes"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const result = await inputHandler(makeInputEvent({ text: "test" }), ctx);

    expect(result).toMatchObject({ action: "handled", handled: true });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("test");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalledWith("   ");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Enhancement returned an empty prompt; restored original prompt.",
      "warning",
    );
  });

  it("handles Escape without waiting for a pending input backup", async () => {
    let resolveBackup!: () => void;
    const backupPromise = new Promise<void>((resolve) => {
      resolveBackup = resolve;
    });
    vi.mocked(copyToClipboard).mockReturnValueOnce(backupPromise);
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
    const resultPromise = Promise.resolve(inputHandler(makeInputEvent({ text: "backup pending prompt" }), ctx));
    let settledResult: InputEventResult | void | undefined;
    resultPromise.then((result) => {
      settledResult = result;
    });

    await vi.waitFor(() => {
      expect(ctx.ui.onTerminalInput).toHaveBeenCalledTimes(1);
    });

    const terminalHandler = (ctx.ui.onTerminalInput as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as (data: string) => { consume?: boolean } | undefined;
    expect(terminalHandler("\u001b")).toEqual({ consume: true });
    await flushAsyncWork();

    expect(settledResult).toMatchObject({ action: "handled", handled: true });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("backup pending prompt");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(browseCodebase).not.toHaveBeenCalled();
    expect(enhancePrompt).not.toHaveBeenCalled();

    resolveBackup();
    await resultPromise;
  });

  it("handles Escape during enhancement by aborting, restoring original input, and not sending stale text", async () => {
    let resolveEnhance!: (value: Awaited<ReturnType<typeof mockEnhancePrompt>>) => void;
    mockEnhancePrompt.mockReturnValueOnce(new Promise((resolve) => {
      resolveEnhance = resolve;
    }));

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
      expect(enhancePrompt).toHaveBeenCalledTimes(1);
    });

    const enhanceSignal = (enhancePrompt as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].signal as AbortSignal;
    const terminalHandler = (ctx.ui.onTerminalInput as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as (data: string) => { consume?: boolean } | undefined;
    expect(terminalHandler("x")).toBeUndefined();
    expect(terminalHandler("\u001b")).toEqual({ consume: true });

    const result = await resultPromise;
    expect(result).toMatchObject({ action: "handled", handled: true });
    expect(enhanceSignal.aborted).toBe(true);
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("exact original sentence");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Enhancement cancelled; restored original prompt.",
      "info",
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-prompt-gen", undefined);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    resolveEnhance(makeLateEnhanceResult());
    await flushAsyncWork();
    expect(browseCodebase).not.toHaveBeenCalled();
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith("exact original sentence");
    expect(copyToClipboard).not.toHaveBeenCalledWith("Enhanced result text");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalledWith("Enhanced result text");
  });

  it("warns and still cancels when restoring original input fails", async () => {
    let resolveEnhance!: (value: Awaited<ReturnType<typeof mockEnhancePrompt>>) => void;
    mockEnhancePrompt.mockReturnValueOnce(new Promise((resolve) => {
      resolveEnhance = resolve;
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
      expect(enhancePrompt).toHaveBeenCalledTimes(1);
    });

    const terminalHandler = (ctx.ui.onTerminalInput as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as (data: string) => { consume?: boolean } | undefined;
    expect(() => terminalHandler("\u001b")).not.toThrow();

    const result = await resultPromise;
    expect(result).toMatchObject({ action: "handled", handled: true });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Enhancement cancelled, but failed to restore original prompt. The original prompt was copied to clipboard before enhancement.",
      "warning",
    );

    resolveEnhance(makeLateEnhanceResult());
    await flushAsyncWork();
    expect(browseCodebase).not.toHaveBeenCalled();
  });

  it("does not claim clipboard recovery when backup and editor restore both fail", async () => {
    vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error("copy failed"));
    let resolveEnhance!: (value: Awaited<ReturnType<typeof mockEnhancePrompt>>) => void;
    mockEnhancePrompt.mockReturnValueOnce(new Promise((resolve) => {
      resolveEnhance = resolve;
    }));

    const ui = {
      ...makeMockContext().ui,
      select: vi.fn().mockResolvedValue("Yes"),
      setEditorText: vi.fn(() => {
        throw new Error("editor restore failed");
      }),
    } as ExtensionUIContext;
    const ctx = makeMockContext({ ui });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const resultPromise = inputHandler(makeInputEvent({ text: "no backup prompt" }), ctx);

    await vi.waitFor(() => {
      expect(ctx.ui.onTerminalInput).toHaveBeenCalledTimes(1);
      expect(enhancePrompt).toHaveBeenCalledTimes(1);
    });

    const terminalHandler = (ctx.ui.onTerminalInput as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as (data: string) => { consume?: boolean } | undefined;
    expect(terminalHandler("\u001b")).toEqual({ consume: true });

    const result = await resultPromise;
    expect(result).toMatchObject({ action: "handled", handled: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Could not copy original prompt to clipboard before enhancement; continuing.",
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Enhancement cancelled, but failed to restore original prompt. The original prompt could not be copied to clipboard before enhancement.",
      "warning",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      "Enhancement cancelled, but failed to restore original prompt. The original prompt was copied to clipboard before enhancement.",
      "warning",
    );

    resolveEnhance(makeLateEnhanceResult());
    await flushAsyncWork();
    expect(browseCodebase).not.toHaveBeenCalled();
  });

  it("treats provider AbortError as an enhancement failure unless the inline signal was aborted", async () => {
    mockEnhancePrompt.mockRejectedValueOnce(new DOMException("provider aborted", "AbortError"));

    const ui = {
      ...makeMockContext().ui,
      select: vi.fn().mockResolvedValue("Yes"),
    } as ExtensionUIContext;
    const ctx = makeMockContext({ ui });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const inputHandler = getRegisteredInputHandler(pi);
    const result = await inputHandler(makeInputEvent({ text: "provider abort prompt" }), ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Enhancement failed: provider aborted", "error");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      "Enhancement cancelled; restored original prompt.",
      "info",
    );
    expect(ctx.ui.setEditorText).not.toHaveBeenCalledWith("provider abort prompt");
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
    expect(result).toMatchObject({ action: "handled", handled: true });
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
    await flushAsyncWork();

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
