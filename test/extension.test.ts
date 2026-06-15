/**
 * Tests for extensions/index.ts — extension command registration and wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

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

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    copyToClipboard: vi.fn().mockResolvedValue(undefined),
  };
});

const { default: registerPiPromptGen } = await import("../extensions/index.js");
const { enhancePrompt } = await import("../src/index.js");
const { browseCodebase } = await import("../src/browse-pass.js");
const { PromptGenModal } = await import("../src/modal.js");
const { copyToClipboard } = await import("@earendil-works/pi-coding-agent");

function makeModel(): Model<Api> {
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
      getAvailable: vi.fn(),
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
  vi.clearAllMocks();
  mockBrowseCodebase.mockResolvedValue([]);
  mockEnhancePrompt.mockResolvedValue({
    enhancedPrompt: "Enhanced result text",
    refs: [],
    systemPrompt: "",
    modelResult: { content: "Enhanced result text", stopReason: "stop" },
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

  it("rejects the global shortcut in non-TUI mode before resolving model auth", async () => {
    const getApiKeyAndHeaders = vi.fn().mockResolvedValue({ ok: false, error: "should not run" });
    const ctx = makeMockContext({
      mode: "print",
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
      "The global pi-prompt-gen shortcut is available in Pi TUI mode only.",
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

  it("notifies error when API key is missing", async () => {
    const modelRegistry = {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: false, error: "No key for test-provider" }),
    } as any;

    const ctx = makeMockContext({ modelRegistry });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No API key configured"),
      "error",
    );
  });
});

describe("Command handler — prefill behavior (TUI)", () => {
  it("runs inline enhancement immediately when args are provided", async () => {
    const ctx = makeMockContext();
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("fix the sidebar sort", ctx);

    expect(PromptGenModal).not.toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      input: "fix the sidebar sort",
      mode: "rewrite",
    }));
    expect(copyToClipboard).toHaveBeenCalledWith("Enhanced result text");
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("Enhanced result text");
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
    await command.handler("test", ctx);

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

  it("warns specifically when inline clipboard copy fails after enhancement succeeds", async () => {
    vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error("copy failed"));

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
    expect(ctx.ui.notify).toHaveBeenCalledWith("Enhanced prompt copied to clipboard.", "info");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Enhancement failed"), "error");
  });

  it("warns specifically when inline editor write and clipboard copy both fail", async () => {
    vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error("copy failed"));

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

describe("Command handler — enhance function wrapper", () => {
  it("runs an isolated browse pass with the active model before enhancement", async () => {
    mockBrowseCodebase.mockResolvedValue([
      { path: "src/sidebar.ts", score: 97, isEntrypoint: false },
      { path: "src/main.ts", score: 88, isEntrypoint: true },
    ]);

    const ctx = makeMockContext({ cwd: "/my/project" });
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await modalOptions.enhanceFn("my text", "generate");

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      input: "my text",
      cwd: "/my/project",
      model: ctx.model,
      apiKey: "sk-test",
      headers: undefined,
      tools: ["read", "grep", "find", "ls", "code_search", "project_memory_read", "project_memory_search", "codegraph_explore", "codegraph_node", "codegraph_status"],
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
    }));
  });

  it("passes a progress callback into the browse pass", async () => {
    const ctx = makeMockContext();
    const pi = makeExtensionAPI();

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const onProgress = vi.fn();
    await modalOptions.enhanceFn("my text", "generate", undefined, undefined, onProgress);

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
    await modalOptions.enhanceFn("my text", "generate");

    expect(browseCodebase).toHaveBeenCalledWith(expect.objectContaining({
      tools: ["read", "code_search"],
    }));
  });

  it("skips the browse pass when no safe browse tools are available", async () => {
    const ctx = makeMockContext({ cwd: "/my/project" });
    const pi = makeExtensionAPI({
      getAllTools: vi.fn().mockReturnValue([{ name: "write" }]),
    });

    registerPiPromptGen(pi);
    const command = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await command.handler("", ctx);

    const modalOptions = (PromptGenModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await modalOptions.enhanceFn("my text", "generate");

    expect(browseCodebase).not.toHaveBeenCalled();
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
