/**
 * Tests for extensions/index.ts — extension command registration and wiring.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api, ModelThinkingLevel } from "@earendil-works/pi-ai";

const testPaths = vi.hoisted(() => ({ agentDir: `/tmp/pi-prompt-gen-extension-test-${process.pid}` }));

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
const { PromptGenModal } = await import("../src/modal.js");
const { copyToClipboard } = await import("@earendil-works/pi-coding-agent");

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

function makeMockContext(overrides?: Partial<ExtensionCommandContext>): ExtensionCommandContext {
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
  } as unknown as ExtensionUIContext;

  return {
    ui,
    mode: "tui",
    hasUI: true,
    model: makeModel(),
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-test", headers: undefined }),
      getAll: vi.fn(),
      getAvailable: vi.fn().mockReturnValue([makeModel()]),
      find: vi.fn(),
      hasConfiguredAuth: vi.fn(),
      getApiKeyForProvider: vi.fn(),
      refresh: vi.fn(),
      getError: vi.fn(),
      getProviderAuthStatus: vi.fn(),
      getProviderDisplayName: vi.fn(),
    } as any,
    cwd: "/test/project",
    isIdle: vi.fn().mockReturnValue(true),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue(""),
    shutdown: vi.fn(),
    abort: vi.fn(),
    isProjectTrusted: vi.fn().mockReturnValue(true),
    signal: undefined,
    hasPendingMessages: vi.fn().mockReturnValue(false),
    getContextUsage: vi.fn(),
    getSystemPromptOptions: vi.fn(),
    newSession: vi.fn(),
    fork: vi.fn(),
    navigateTree: vi.fn(),
    switchSession: vi.fn(),
    reload: vi.fn(),
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
      { name: "web_search" },
      { name: "fetch_content" },
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

describe("Extension registration", () => {
  it("registers the /prompt command and the global shortcut", () => {
    const pi = makeExtensionAPI();
    registerPiPromptGen(pi);

    expect(pi.registerCommand).toHaveBeenCalledTimes(1);
    expect(pi.registerCommand).toHaveBeenCalledWith("prompt", expect.objectContaining({
      description: expect.stringContaining("prompt enhancer"),
    }));
    expect(pi.registerShortcut).toHaveBeenCalledWith("ctrl+shift+g", expect.objectContaining({
      description: expect.stringContaining("pi-prompt-gen modal"),
    }));
  });

  it("opens from the global shortcut without requiring waitForIdle on shortcut context", async () => {
    const pi = makeExtensionAPI();
    const ctx = makeMockContext({ waitForIdle: undefined as any });
    registerPiPromptGen(pi);

    const shortcut = (pi.registerShortcut as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await shortcut.handler(ctx);

    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("rejects the global shortcut without interactive UI before resolving model auth", async () => {
    const getApiKeyAndHeaders = vi.fn().mockResolvedValue({ ok: false, error: "should not run" });
    const ctx = makeMockContext({
      hasUI: false,
      waitForIdle: undefined as any,
      modelRegistry: {
        ...makeMockContext().modelRegistry,
        getApiKeyAndHeaders,
      } as any,
    });
    const pi = makeExtensionAPI();
    registerPiPromptGen(pi);

    const shortcut = (pi.registerShortcut as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await shortcut.handler(ctx);

    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "The global pi-prompt-gen shortcut is available in interactive UI mode only.",
      "warning",
    );
  });
});

describe("Command handler — model resolution", () => {
  it("notifies error when no model is selected", async () => {
    const ctx = makeMockContext({ model: undefined });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No active model"),
      "error",
    );
  });

  it("notifies error when API key is missing for inline enhancement", async () => {
    const modelRegistry = {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: false, error: "No key for test-provider" }),
    } as any;

    const ctx = makeMockContext({ modelRegistry });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("fix this prompt", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No API key configured"),
      "error",
    );
  });

  it("uses provider-key model registry fallback for OMP-compatible hosts", async () => {
    const getApiKeyForProvider = vi.fn().mockResolvedValue("sk-provider");
    const model = makeModel({ id: "gpt-5.5", provider: "openai" });
    const ctx = makeMockContext({
      model,
      modelRegistry: {
        getAvailable: vi.fn().mockReturnValue([model]),
        getApiKeyForProvider,
      } as never,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("fix this prompt", ctx);

    expect(getApiKeyForProvider).toHaveBeenCalledWith("openai", undefined, {
      baseUrl: model.baseUrl,
      modelId: "gpt-5.5",
    });
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "sk-provider",
    }));
  });
});

describe("Command handler — prefill behavior (TUI)", () => {
  it("runs inline enhancement immediately without browsing when plain args are provided", async () => {
    const ctx = makeMockContext();
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("fix the sidebar sort", ctx);

    expect(PromptGenModal).not.toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(browseCodebase).not.toHaveBeenCalled();
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "fix the sidebar sort",
      mode: "rewrite",
      relevantRefs: [],
      gitContext: undefined,
      sessionContext: undefined,
    }));
    expect(copyToClipboard).toHaveBeenNthCalledWith(1, "fix the sidebar sort");
    expect(copyToClipboard).toHaveBeenNthCalledWith(2, "Enhanced result text");
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("Enhanced result text");
  });

  it("runs inline enhancement with repo browsing when --browse is provided", async () => {
    mockBrowseCodebase.mockResolvedValueOnce({
      refs: [{ path: "src/sidebar.ts", score: 95, isEntrypoint: true }],
      gitContext: { branch: "feat/sidebar" },
      sessionContext: undefined,
    });
    const ctx = makeMockContext();
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("--browse fix the sidebar sort", ctx);

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      input: "fix the sidebar sort",
      cwd: "/test/project",
    }));
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "fix the sidebar sort",
      relevantRefs: [{ path: "src/sidebar.ts", score: 95, isEntrypoint: true }],
      gitContext: { branch: "feat/sidebar" },
    }));
    expect(copyToClipboard).toHaveBeenNthCalledWith(1, "fix the sidebar sort");
  });

  it("accepts #browse in inline prompt text as a repo browsing opt-in", async () => {
    const ctx = makeMockContext();
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("fix the sidebar sort #browse.", ctx);

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      input: "fix the sidebar sort #browse.",
      cwd: "/test/project",
    }));
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "fix the sidebar sort #browse.",
    }));
  });

  it("accepts -b as a short browse flag", async () => {
    const ctx = makeMockContext();
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("-b fix the sidebar sort", ctx);

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      input: "fix the sidebar sort",
    }));
  });

  it("treats -- after flags as literal prompt text", async () => {
    const ctx = makeMockContext();
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("-- --browse should stay in the prompt", ctx);

    expect(browseCodebase).not.toHaveBeenCalled();
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "--browse should stay in the prompt",
    }));
  });

  it("preserves prompt whitespace after leading browse flags", async () => {
    const ctx = makeMockContext();
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("--browse   fix   the\nsidebar sort", ctx);

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      input: "fix   the\nsidebar sort",
    }));
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "fix   the\nsidebar sort",
    }));
    expect(copyToClipboard).toHaveBeenNthCalledWith(1, "fix   the\nsidebar sort");
  });

  it("backs up the original inline input to clipboard before enhancement can fail", async () => {
    mockEnhancePrompt.mockRejectedValueOnce(new Error("model exploded"));
    const ctx = makeMockContext();
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("recover this exact prompt", ctx);

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith("recover this exact prompt");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Enhancement failed: model exploded", "error");
  });

  it("prefills from editor text when no args and editor has text", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        getEditorText: vi.fn().mockReturnValue("editor content here"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    expect(PromptGenModal).toHaveBeenCalledWith(expect.objectContaining({
      initialText: "editor content here",
      mode: "rewrite",
    }));
  });

  it("prefills from session context when args/editor are empty", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        getEditorText: vi.fn().mockReturnValue(""),
      } as ExtensionUIContext,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([
          {
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "session user context" }],
            },
          },
        ]),
        getEntries: vi.fn().mockReturnValue([]),
      } as any,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    expect(PromptGenModal).toHaveBeenCalledWith(expect.objectContaining({
      initialText: "session user context",
      mode: "rewrite",
    }));
  });

  it("starts blank (generate mode) when args, editor, and session context are empty", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        getEditorText: vi.fn().mockReturnValue(""),
      } as ExtensionUIContext,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([]),
        getEntries: vi.fn().mockReturnValue([]),
      } as any,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    expect(PromptGenModal).toHaveBeenCalledWith(expect.objectContaining({
      initialText: "",
      mode: "generate",
    }));
  });

  it("opens the modal with repo context enabled when --browse is provided without inline text", async () => {
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        getEditorText: vi.fn().mockReturnValue(""),
      } as ExtensionUIContext,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([]),
        getEntries: vi.fn().mockReturnValue([]),
      } as any,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("--browse", ctx);

    expect(PromptGenModal).toHaveBeenCalledWith(expect.objectContaining({
      initialText: "",
      mode: "generate",
      initialBrowseEnabled: true,
    }));
  });
});

describe("Command handler — TUI vs non-TUI fallback", () => {
  it("uses modal in TUI mode when no args are provided", async () => {
    const ctx = makeMockContext({ mode: "tui", hasUI: true });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    expect(ctx.ui.custom).toHaveBeenCalled();
  });

  it("uses modal in OMP interactive mode when no args are provided", async () => {
    const ctx = makeMockContext({ mode: "interactive" as ExtensionCommandContext["mode"], hasUI: true });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.editor).not.toHaveBeenCalled();
    expect(enhancePrompt).not.toHaveBeenCalled();
  });

  it("shows inline status progress while enhancing args", async () => {
    mockBrowseCodebase.mockImplementation(async ({ onProgress }) => {
      onProgress?.("Examining codebase…");
      onProgress?.("Reading src/index.ts…");
      return [];
    });

    const ctx = makeMockContext({ mode: "tui", hasUI: true });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("--browse test", ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "pi-prompt-gen",
      expect.stringContaining("Examining codebase"),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "pi-prompt-gen",
      expect.stringContaining("Reading src/index.ts"),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-prompt-gen", undefined);
  });

  it("uses non-TUI fallback when mode is not TUI", async () => {
    const ctx = makeMockContext({
      mode: "rpc",
      hasUI: true,
      ui: {
        ...makeMockContext().ui,
        getEditorText: vi.fn().mockReturnValue(""),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("test input", ctx);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "test input",
      mode: "rewrite",
    }));
  });

  it("keeps --browse enabled through non-TUI fallback with prefilled text", async () => {
    const ctx = makeMockContext({
      mode: "rpc",
      hasUI: true,
      ui: {
        ...makeMockContext().ui,
        custom: undefined as never,
        getEditorText: vi.fn().mockReturnValue("prefilled prompt"),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("--browse", ctx);

    expect(ctx.ui.custom).toBeUndefined();
    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      input: "prefilled prompt",
      cwd: "/test/project",
    }));
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "prefilled prompt",
      mode: "rewrite",
    }));
  });

  it("non-TUI fallback copies result to clipboard and writes to editor", async () => {
    const ctx = makeMockContext({
      mode: "print",
      hasUI: true,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("test input", ctx);

    expect(copyToClipboard).toHaveBeenCalledWith("Enhanced result text");
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("Enhanced result text");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("copied to clipboard"),
      "info",
    );
  });

  it("inline success notification includes metadata summary (model, stop, latency)", async () => {
    // The mock result in beforeEach has metadata with modelName, stopReason,
    // latencyMs but no usageSummary — only model, stop, and latency appear.
    const ctx = makeMockContext({
      mode: "print",
      hasUI: true,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("test input", ctx);

    // The notify message should contain the metadata summary
    const infoCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[1] === "info"
    );
    const lastInfoCall = infoCalls[infoCalls.length - 1];
    expect(lastInfoCall).toBeDefined();
    expect(lastInfoCall[0]).toContain("Test Model");
    expect(lastInfoCall[0]).toContain("stop");
    expect(lastInfoCall[0]).toContain("0.5s");
    // No token info since usageSummary is absent in the mock
    expect(lastInfoCall[0]).not.toContain("tok");
  });

  it("inline notification omits metadata summary fields when absent", async () => {
    mockEnhancePrompt.mockResolvedValueOnce({
      enhancedPrompt: "No metadata result",
      refs: [],
      systemPrompt: "",
      modelResult: { content: "No metadata result", stopReason: "stop" },
      metadata: {
        refCount: 0,
      },
    });
    const ctx = makeMockContext({
      mode: "print",
      hasUI: true,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("test input", ctx);

    // Should still succeed with a basic notification
    const infoCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[1] === "info"
    );
    const lastInfoCall = infoCalls[infoCalls.length - 1];
    expect(lastInfoCall).toBeDefined();
    expect(lastInfoCall[0]).toContain("copied to clipboard");
    // No metadata segments since fields are absent
    expect(lastInfoCall[0]).not.toContain("·");
  });

  it("warns specifically when inline clipboard copy fails after enhancement succeeds", async () => {
    vi.mocked(copyToClipboard)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("copy failed"));

    const ctx = makeMockContext({
      mode: "print",
      hasUI: true,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("test input", ctx);

    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("Enhanced result text");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Enhanced prompt written to editor, but failed to copy to clipboard.",
      "warning",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Enhancement failed"), "error");
  });

  it("warns specifically when inline editor write fails after enhancement succeeds", async () => {
    const ctx = makeMockContext({
      mode: "print",
      hasUI: true,
      ui: {
        ...makeMockContext().ui,
        setEditorText: vi.fn(() => {
          throw new Error("editor failed");
        }),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("test input", ctx);

    expect(copyToClipboard).toHaveBeenCalledWith("Enhanced result text");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Enhanced prompt ready, but failed to write to editor.",
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Enhanced prompt copied to clipboard"),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Enhancement failed"), "error");
  });

  it("warns specifically when inline editor write and clipboard copy both fail", async () => {
    vi.mocked(copyToClipboard)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("copy failed"));

    const ctx = makeMockContext({
      mode: "print",
      hasUI: true,
      ui: {
        ...makeMockContext().ui,
        setEditorText: vi.fn(() => {
          throw new Error("editor failed");
        }),
      } as ExtensionUIContext,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("test input", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Enhanced prompt ready, but failed to write to editor or copy to clipboard.",
      "warning",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Enhancement failed"), "error");
  });

  it("throws an explicit error in no-UI contexts", async () => {
    const ctx = makeMockContext({
      mode: "print",
      hasUI: false,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await expect(command.handler("", ctx)).rejects.toThrow(
      "requires Pi TUI or an interactive UI-capable mode",
    );
  });
});

describe("Command handler — sendUserMessage integration", () => {
  it("modal sendFn calls pi.sendUserMessage", async () => {
    const pi = makeExtensionAPI();
    const ctx = makeMockContext();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await modalOptions.sendFn("send this text");
    expect(pi.sendUserMessage).toHaveBeenCalledWith("send this text");
  });

  it("modal sendFn clears the parent editor after sending", async () => {
    const pi = makeExtensionAPI();
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        getEditorText: vi.fn().mockReturnValue("prefilled draft"),
      } as ExtensionUIContext,
    });

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await modalOptions.sendFn("send this text");

    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("");
  });

  it("modal sendFn treats editor clearing as best-effort after a successful send", async () => {
    const pi = makeExtensionAPI();
    const ctx = makeMockContext({
      ui: {
        ...makeMockContext().ui,
        setEditorText: vi.fn(() => {
          throw new Error("clear failed");
        }),
      } as ExtensionUIContext,
    });

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await expect(modalOptions.sendFn("send this text")).resolves.toBeUndefined();

    expect(pi.sendUserMessage).toHaveBeenCalledWith("send this text");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Sent prompt, but failed to clear the editor.",
      "warning",
    );
  });
});

describe("Command handler — modal model/thinking persistence", () => {
  it("passes enabled model settings and persisted thinking into the modal", async () => {
    const first = makeModel({ id: "gpt-5.5", name: "gpt-5.5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
    const second = makeModel({ id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic", reasoning: true });
    const third = makeModel({ id: "gemini-pro", name: "Gemini Pro", provider: "google", reasoning: true });
    mkdirSync(testPaths.agentDir, { recursive: true });
    writeFileSync(`${testPaths.agentDir}/prompt-gen-settings.json`, JSON.stringify({
      modelProvider: "anthropic",
      modelId: "claude-sonnet",
      thinkingLevel: "high" satisfies ModelThinkingLevel,
    }));
    const ctx = makeMockContext({
      model: first,
      modelRegistry: {
        ...makeMockContext().modelRegistry,
        getAvailable: vi.fn().mockReturnValue([first, second, third]),
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-test", headers: undefined }),
      } as any,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([]),
        getEntries: vi.fn().mockReturnValue([]),
      } as any,
    } as Partial<ExtensionCommandContext>);
    settingsMocks.getEnabledModels.mockReturnValue(["test-provider/gpt-*", "anthropic/*:high"]);
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    expect(PromptGenModal).toHaveBeenCalledWith(expect.objectContaining({
      availableModels: [first, second],
      selectedModel: second,
      selectedThinkingLevel: "high",
    }));
  });

  it("persists model and thinking changes globally for later Prompt Gen modals", async () => {
    const first = makeModel({ id: "gpt-5.5", name: "gpt-5.5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
    const second = makeModel({ id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic", reasoning: true });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const makeCtx = (cwd: string) => makeMockContext({
      cwd,
      model: first,
      modelRegistry: {
        ...makeMockContext().modelRegistry,
        getAvailable: vi.fn().mockReturnValue([first, second]),
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-test", headers: undefined }),
      } as any,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([]),
        getEntries: vi.fn().mockReturnValue([]),
      } as any,
    });

    await command.handler("", makeCtx("/project/a"));
    const firstModalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    firstModalOptions.onSelectionChange({ model: second, thinkingLevel: "high" });

    await command.handler("", makeCtx("/project/b"));

    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(PromptGenModal).toHaveBeenLastCalledWith(expect.objectContaining({
      selectedModel: second,
      selectedThinkingLevel: "high",
    }));
  });

  it("uses persisted modal model and thinking for browse and enhancement", async () => {
    const first = makeModel({ id: "gpt-5.5", name: "gpt-5.5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
    const second = makeModel({ id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic", reasoning: true });
    const ctx = makeMockContext({
      model: first,
      modelRegistry: {
        ...makeMockContext().modelRegistry,
        getAvailable: vi.fn().mockReturnValue([first, second]),
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-test", headers: undefined }),
      } as any,
    });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    modalOptions.onSelectionChange({ model: second, thinkingLevel: "high" });
    await modalOptions.enhanceFn("my text", "generate", undefined, undefined, undefined, undefined, { browse: true });

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      model: second,
    }));
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      model: second,
      thinkingLevel: "high",
    }));
  });
});

describe("Command handler — enhance function wrapper", () => {
  it("runs an isolated browse pass with the active model before enhancement", async () => {
    mockBrowseCodebase.mockResolvedValue({
      refs: [
        { path: "src/sidebar.ts", score: 97, isEntrypoint: false },
        { path: "src/main.ts", score: 88, isEntrypoint: true },
      ],
      gitContext: {
        branch: "feat/prompt-browse-context",
        statusSummary: "2 unstaged files.",
        changedFiles: ["src/browse-pass.ts"],
        diffSummary: "Browse-pass plumbing is being updated.",
      },
      sessionContext: {
        relevantMessages: [
          { role: "user", text: "Please make the prompt generator understand follow-up context." },
        ],
      },
    });

    const ctx = makeMockContext({ cwd: "/my/project" });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const enhanced = await modalOptions.enhanceFn("my text", "generate", undefined, undefined, undefined, undefined, { browse: true });

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      input: "my text",
      cwd: "/my/project",
      model: ctx.model,
      apiKey: "sk-test",
      headers: undefined,
      tools: ["read", "grep", "find", "ls", "code_search", "project_memory_read", "project_memory_search", "codegraph_explore", "codegraph_node", "codegraph_status"],
      sessionHistory: [],
    }));

    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "my text",
      mode: "generate",
      model: ctx.model,
      apiKey: "sk-test",
      headers: undefined,
      relevantRefs: [
        { path: "src/sidebar.ts", score: 97, isEntrypoint: false },
        { path: "src/main.ts", score: 88, isEntrypoint: true },
      ],
      gitContext: {
        branch: "feat/prompt-browse-context",
        statusSummary: "2 unstaged files.",
        changedFiles: ["src/browse-pass.ts"],
        diffSummary: "Browse-pass plumbing is being updated.",
      },
      sessionContext: {
        relevantMessages: [
          { role: "user", text: "Please make the prompt generator understand follow-up context." },
        ],
      },
    }));
    expect((enhancePrompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty("browseToolsUsed");
    expect(enhanced.metadata.browseToolsUsed).toEqual([
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
  });

  it("passes a progress callback into the browse pass", async () => {
    const ctx = makeMockContext();
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const onProgress = vi.fn();
    await modalOptions.enhanceFn("my text", "generate", undefined, undefined, onProgress, undefined, { browse: true });

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      onProgress,
    }));
  });

  it("filters session-coupled and network-capable tools out of the browse allowlist", async () => {
    const ctx = makeMockContext({ cwd: "/my/project" });
    const pi = makeExtensionAPI({
      getAllTools: vi.fn().mockReturnValue([
        { name: "read" },
        { name: "diagnostics" },
        { name: "editor_context" },
        { name: "code_search" },
        { name: "web_search" },
        { name: "fetch_content" },
      ]),
    });

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await modalOptions.enhanceFn("my text", "generate", undefined, undefined, undefined, undefined, { browse: true });

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      tools: ["read", "code_search"],
    }));
  });

  it("passes current-branch user and assistant messages into the browse pass as queryable history", async () => {
    const ctx = makeMockContext({
      cwd: "/my/project",
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([
          { type: "message", message: { role: "user", content: [{ type: "text", text: "Review the extension docs and inspect git diff support." }] } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "The current browse pass lacks git diff visibility." }] } },
          { type: "message", message: { role: "tool", content: [{ type: "text", text: "ignore me" }] } },
        ]),
        getEntries: vi.fn().mockReturnValue([]),
      } as any,
    });
    const pi = makeExtensionAPI({
      getAllTools: vi.fn().mockReturnValue([{ name: "write" }]),
    });

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await modalOptions.enhanceFn("my text", "generate", undefined, undefined, undefined, undefined, { browse: true });

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      tools: [],
      sessionHistory: [
        { role: "user", text: "Review the extension docs and inspect git diff support." },
        { role: "assistant", text: "The current browse pass lacks git diff visibility." },
      ],
    }));
  });

  it("does not fall back to full session entries for browse history when current-branch access is unavailable", async () => {
    const ctx = makeMockContext({
      cwd: "/my/project",
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([
          { type: "message", message: { role: "user", content: [{ type: "text", text: "non-branch session entry" }] } },
        ]),
      } as any,
    });
    const pi = makeExtensionAPI({
      getAllTools: vi.fn().mockReturnValue([{ name: "write" }]),
    });

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await modalOptions.enhanceFn("my text", "generate", undefined, undefined, undefined, undefined, { browse: true });

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      sessionHistory: [],
    }));
  });

  it("still runs the browse pass when only internal browse context tools are available", async () => {
    const ctx = makeMockContext({ cwd: "/my/project" });
    const pi = makeExtensionAPI({
      getAllTools: vi.fn().mockReturnValue([{ name: "write" }]),
    });

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await modalOptions.enhanceFn("my text", "generate", undefined, undefined, undefined, undefined, { browse: true });

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      tools: [],
      cwd: "/my/project",
    }));
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      relevantRefs: [],
    }));
  });
});

describe("Extension re-exports", () => {
  it("re-exports enhancePrompt and types", async () => {
    const extModule = await import("../extensions/index.js");
    expect(extModule.enhancePrompt).toBeDefined();
    expect(typeof extModule.enhancePrompt).toBe("function");
  });
});
