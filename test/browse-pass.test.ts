/**
 * Tests for browse-pass.ts — isolated read-only browse session setup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";

const mockSetRuntimeApiKey = vi.fn();
const mockRegisterProvider = vi.fn();
const mockReload = vi.fn().mockResolvedValue(undefined);
const mockAbort = vi.fn().mockResolvedValue(undefined);
const mockDispose = vi.fn();
const mockPrompt = vi.fn().mockResolvedValue(undefined);
const mockUnsubscribe = vi.fn();
const loaderOptions: unknown[] = [];

let toolEventListener: ((event: { type: string; toolName: string; args?: unknown }) => void) | undefined;

const mockSession = {
  subscribe: vi.fn((listener: typeof toolEventListener) => {
    toolEventListener = listener;
    return mockUnsubscribe;
  }),
  prompt: mockPrompt,
  abort: mockAbort,
  dispose: mockDispose,
  messages: [] as Array<{ role: string; content: Array<{ type: string; text: string }> }>,
};

const mockCreateAgentSession = vi.fn(async () => ({
  session: mockSession,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    inMemory: vi.fn(() => ({
      setRuntimeApiKey: mockSetRuntimeApiKey,
    })),
  },
  ModelRegistry: {
    inMemory: vi.fn(() => ({
      registerProvider: mockRegisterProvider,
    })),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
    })),
  },
  DefaultResourceLoader: vi.fn().mockImplementation(function DefaultResourceLoaderMock(options: unknown) {
    loaderOptions.push(options);
    return {
      reload: mockReload,
    };
  }),
  SessionManager: {
    inMemory: vi.fn(() => ({
      getBranch: vi.fn(() => []),
    })),
  },
  createAgentSession: mockCreateAgentSession,
  defineTool: vi.fn((tool) => tool),
  getAgentDir: vi.fn(() => "/mock-agent-dir"),
}));

const { browseCodebase, SAFE_BROWSE_TOOL_NAMES } = await import("../src/browse-pass.js");

function makeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "anthropic-messages" as Api,
    provider: "anthropic",
    baseUrl: "https://api.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 2048,
    ...overrides,
  };
}

const tempDirs: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-gen-browse-"));
  tempDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  return root;
}

async function makeGitRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-gen-browse-"));
  tempDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  execSync("git init", { cwd: root, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: root, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: root, stdio: "pipe" });
  execSync("git add -A", { cwd: root, stdio: "pipe" });
  execSync("git commit -m 'initial'", { cwd: root, stdio: "pipe" });

  return root;
}

describe("browseCodebase", () => {
  beforeEach(() => {
    mockSetRuntimeApiKey.mockReset();
    mockRegisterProvider.mockReset();
    mockReload.mockClear();
    mockAbort.mockReset();
    mockDispose.mockReset();
    mockPrompt.mockReset();
    mockPrompt.mockResolvedValue(undefined);
    mockUnsubscribe.mockReset();
    mockSession.subscribe.mockClear();
    mockCreateAgentSession.mockClear();
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [{ path: "src/index.ts", score: 97, isEntrypoint: true }],
            }),
          },
        ],
      },
    ];
    toolEventListener = undefined;
    loaderOptions.length = 0;
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("creates the isolated browse session with extensions and context files disabled", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });

    const result = await browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read", "grep"],
      sessionHistory: [
        { role: "user", text: "Look into the current prompt generator limitations." },
      ],
    });

    expect(loaderOptions[0]).toEqual(expect.objectContaining({
      noPromptTemplates: true,
      noThemes: true,
      noSkills: true,
      noExtensions: true,
      noContextFiles: true,
    }));
    expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      thinkingLevel: "off",
      tools: ["read", "grep", "git_context", "session_history"],
      toolNames: ["read", "grep", "git_context", "session_history"],
      disableExtensionDiscovery: true,
      preloadedCustomToolPaths: [],
      enableMCP: false,
      customTools: expect.arrayContaining([
        expect.objectContaining({ name: "git_context" }),
        expect.objectContaining({ name: "session_history" }),
      ]),
    }));
    expect(result.refs).toEqual([
      { path: "src/index.ts", score: 97, isEntrypoint: true },
    ]);
  });

  it("filters unsafe tools before creating the temporary agent session while keeping internal browse tools", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });

    await browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read", "write", "web_search", "code_search"],
    });

    expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      tools: ["read", "code_search", "git_context"],
      toolNames: ["read", "code_search", "git_context"],
    }));
  });

  it("keeps only safe repo-relative refs that exist under cwd", async () => {
    const repo = await makeRepo({
      "src/index.ts": "export const ok = true;",
      "src/other.ts": "export const other = true;",
    });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [
                { path: "src/index.ts", score: 97, isEntrypoint: true },
                { path: "./src/other.ts", score: "bad", isEntrypoint: false },
                { path: "/etc/passwd", score: 99, isEntrypoint: false },
                { path: "../outside.ts", score: 75, isEntrypoint: false },
                { path: "src/missing.ts", score: 88, isEntrypoint: false },
                { path: "src/index.ts", score: 12, isEntrypoint: false },
              ],
            }),
          },
        ],
      },
    ];

    const result = await browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    expect(result.refs).toEqual([
      { path: "src/index.ts", score: 97, isEntrypoint: true },
      { path: "src/other.ts", score: 50, isEntrypoint: false },
    ]);
  });

  it("validates structured session context against observed bounded history and rejects unobserved git context", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [{ path: "src/index.ts", score: 97, isEntrypoint: true }],
              gitContext: {
                branch: "hallucinated-branch",
                statusSummary: "999 unstaged files.",
                changedFiles: ["made-up.ts"],
                diffSummary: "Made-up diff summary.",
              },
              sessionContext: {
                relevantMessages: [
                  { role: "user", text: "Please make the prompt generator understand follow-up work." },
                  { role: "assistant", text: "Hallucinated prior answer." },
                ],
              },
            }),
          },
        ],
      },
    ];

    const result = await browseCodebase({
      input: "improve follow-up prompt generation",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
      sessionHistory: [
        { role: "user", text: "Please make the prompt generator understand follow-up work." },
      ],
    });

    expect(result.gitContext).toBeUndefined();
    expect(result.sessionContext).toEqual({
      relevantMessages: [
        { role: "user", text: "Please make the prompt generator understand follow-up work." },
      ],
    });
  });

  it("session_history exposes a bounded latest current-branch snapshot", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    const sessionHistory = Array.from({ length: 45 }, (_, index) => ({
      role: "user" as const,
      text: `message ${index}`,
    }));

    await browseCodebase({
      input: "use recent context",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
      sessionHistory,
    });

    const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
    const customTools = createCalls[0][0].customTools;
    const sessionHistoryTool = customTools.find((tool) => tool.name === "session_history");
    const result = await sessionHistoryTool.execute("tool-call", { offset: 0, limit: 10 });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.messages[0]).toEqual({ index: 0, role: "user", text: "message 5" });
    expect(payload.messages.at(-1)).toEqual({ index: 9, role: "user", text: "message 14" });
    expect(payload.page.total).toBe(40);
  });

  it("git_context rejects pathspec magic instead of broadening a requested path-filtered diff", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });

    await browseCodebase({
      input: "inspect git diff",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
    const customTools = createCalls[0][0].customTools;
    const gitTool = customTools.find((tool) => tool.name === "git_context");
    const result = await gitTool.execute("tool-call", { action: "diff", paths: [":/"] });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toEqual({
      scope: "working_tree",
      diff: "",
      truncated: false,
      paths: [],
    });
  });

  it("normalizes non-finite maxRefs before building prompts and limiting refs", async () => {
    const repo = await makeRepo({
      "src/index.ts": "export const ok = true;",
      "src/other.ts": "export const other = true;",
    });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [
                { path: "src/index.ts", score: 97, isEntrypoint: true },
                { path: "src/other.ts", score: 88, isEntrypoint: false },
              ],
            }),
          },
        ],
      },
    ];

    const result = await browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
      maxRefs: Number.NaN,
    });

    expect(mockPrompt).toHaveBeenCalledWith(expect.stringContaining("at most 5 file refs"));
    expect(result.refs).toHaveLength(2);
  });

  it("rounds down fractional maxRefs before limiting refs", async () => {
    const repo = await makeRepo({
      "src/index.ts": "export const ok = true;",
      "src/other.ts": "export const other = true;",
    });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [
                { path: "src/index.ts", score: 97, isEntrypoint: true },
                { path: "src/other.ts", score: 88, isEntrypoint: false },
              ],
            }),
          },
        ],
      },
    ];

    const result = await browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
      maxRefs: 1.8,
    });

    expect(mockPrompt).toHaveBeenCalledWith(expect.stringContaining("at most 1 file refs"));
    expect(result.refs).toEqual([
      { path: "src/index.ts", score: 97, isEntrypoint: true },
    ]);
  });

  it("drops symlinked refs that resolve outside the repository", async () => {
    const outsideRoot = await makeRepo({ "outside.ts": "export const outside = true;" });
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    await symlink(join(outsideRoot, "outside.ts"), join(repo, "src", "linked-outside.ts"));
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [
                { path: "src/index.ts", score: 97, isEntrypoint: true },
                { path: "src/linked-outside.ts", score: 90, isEntrypoint: false },
              ],
            }),
          },
        ],
      },
    ];

    const result = await browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    expect(result.refs).toEqual([
      { path: "src/index.ts", score: 97, isEntrypoint: true },
    ]);
  });

  it("reports tool progress for repo, git, and session-history tools and parses fenced JSON responses", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: [
              "```json",
              JSON.stringify({ refs: [{ path: "src/index.ts", score: 97, isEntrypoint: true }] }),
              "```",
            ].join("\n"),
          },
        ],
      },
    ];
    mockPrompt.mockImplementation(async () => {
      toolEventListener?.({ type: "tool_execution_start", toolName: "git_context", args: { action: "summary" } });
      toolEventListener?.({ type: "tool_execution_start", toolName: "session_history", args: { limit: 2 } });
      toolEventListener?.({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
    });

    const onProgress = vi.fn();
    const result = await browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
      sessionHistory: [
        { role: "user", text: "Please use the latest conversation context if needed." },
      ],
      onProgress,
    });

    expect(onProgress.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      "Examining codebase…",
      "Inspecting git context…",
      "Reading session history…",
      "Reading src/index.ts…",
      "Selecting useful references…",
    ]));
    expect(result.refs).toEqual([
      { path: "src/index.ts", score: 97, isEntrypoint: true },
    ]);
  });

  it("fails fast when the signal is already aborted", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    const controller = new AbortController();
    controller.abort();

    await expect(browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
      signal: controller.signal,
    })).rejects.toThrow(/abort/i);

    expect(mockReload).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it("aborts the session and rejects when the signal aborts mid-prompt", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    const controller = new AbortController();

    mockPrompt.mockImplementation(async () => {
      controller.abort();
    });

    await expect(browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
      signal: controller.signal,
    })).rejects.toThrow(/abort/i);

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it("cleans up the session if the signal aborts immediately after session creation", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    const controller = new AbortController();

    mockCreateAgentSession.mockImplementationOnce(async () => {
      controller.abort();
      return { session: mockSession };
    });

    await expect(browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
      signal: controller.signal,
    })).rejects.toThrow(/abort/i);

    expect(mockSession.subscribe).not.toHaveBeenCalled();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes and disposes the temporary session when prompt fails", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    mockPrompt.mockRejectedValue(new Error("browse failed"));

    await expect(browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    })).rejects.toThrow("browse failed");

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Richer ref metadata parsing (reason, role, symbols)
  // -------------------------------------------------------------------------

  it("parses refs with reason, role, and symbols from JSON", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [
                {
                  path: "src/index.ts",
                  score: 97,
                  isEntrypoint: true,
                  reason: "Entry point for the module",
                  role: "implementation",
                  symbols: ["defaultExport", "helper"],
                },
              ],
            }),
          },
        ],
      },
    ];

    const result = await browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    expect(result.refs).toEqual([
      {
        path: "src/index.ts",
        score: 97,
        isEntrypoint: true,
        reason: "Entry point for the module",
        role: "implementation",
        symbols: ["defaultExport", "helper"],
      },
    ]);
  });

  it("parses old-style refs without reason/role/symbols (backwards compat)", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [
                { path: "src/index.ts", score: 97, isEntrypoint: true },
              ],
            }),
          },
        ],
      },
    ];

    const result = await browseCodebase({
      input: "fix sidebar sorting",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    expect(result.refs).toEqual([
      { path: "src/index.ts", score: 97, isEntrypoint: true },
    ]);
  });

  it("sanitizes reason/role/symbols with control characters", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [
                {
                  path: "src/index.ts",
                  score: 95,
                  isEntrypoint: false,
                  reason: "Important\x00file with\x01control chars",
                  role: "bad\x0Brole",
                  symbols: ["cleanSym", "bad\x00sym"],
                },
              ],
            }),
          },
        ],
      },
    ];

    const result = await browseCodebase({
      input: "test",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    // normalizeInlineText strips control characters entirely, does not
    // replace them with spaces, so "Important\x00file with\x01control chars"
    // becomes "Importantfile withcontrol chars" (the null and SOH are removed).
    expect(result.refs[0].reason).toBe("Importantfile withcontrol chars");
    expect(result.refs[0].role).toBe("badrole");
    expect(result.refs[0].symbols).toEqual(["cleanSym", "badsym"]);
  });

  it("truncates long reason and limits symbols count", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [
                {
                  path: "src/index.ts",
                  score: 95,
                  isEntrypoint: false,
                  reason: "A".repeat(300),
                  role: "testing",
                  symbols: ["sym1", "sym2", "sym3", "sym4", "sym5", "sym6"],
                },
              ],
            }),
          },
        ],
      },
    ];

    const result = await browseCodebase({
      input: "test",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    expect(result.refs[0].reason?.length).toBe(200);
    expect(result.refs[0].symbols?.length).toBe(5);
    expect(result.refs[0].role).toBe("testing");
  });

  // -------------------------------------------------------------------------
  // Browse prompt / schema mentions metadata fields and limits
  // -------------------------------------------------------------------------

  it("builds a browse system prompt that mentions reason, role, and symbol limits", async () => {
    // We must call browseCodebase to trigger DefaultResourceLoader construction.
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: JSON.stringify({ refs: [{ path: "src/index.ts", score: 97, isEntrypoint: true }] }) },
        ],
      },
    ];

    await browseCodebase({
      input: "test",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    // Inspect the systemPromptOverride captured from the last DefaultResourceLoader call
    const loaderCall = loaderOptions[loaderOptions.length - 1] as { systemPromptOverride?: () => string };
    expect(loaderCall).toBeDefined();
    const systemPrompt = loaderCall.systemPromptOverride?.();
    expect(systemPrompt).toBeDefined();

    // The JSON example should include reason, role, and symbols fields
    expect(systemPrompt).toContain("reason");
    expect(systemPrompt).toContain("role");
    expect(systemPrompt).toContain("symbols");

    // It should mention specific limits
    expect(systemPrompt).toContain("max 200 chars");
    expect(systemPrompt).toContain("max 50 chars");
    expect(systemPrompt).toContain("at most 5, each max 100 chars");

    // The JSON example should include a ref with reason, role, and symbols
    expect(systemPrompt).toContain("Entry point for the main module");
    expect(systemPrompt).toContain("implementation");
    expect(systemPrompt).toContain("startApp");
    expect(systemPrompt).toContain("config");
  });

  it("build user prompt for browse also mentions reason, role, and symbols", async () => {
    const repo = await makeRepo({ "src/index.ts": "export const ok = true;" });
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: JSON.stringify({ refs: [{ path: "src/index.ts", score: 97, isEntrypoint: true }] }) },
        ],
      },
    ];

    await browseCodebase({
      input: "test",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    // Verify that the user prompt (passed to session.prompt) mentions
    // metadata fields — distinct from the system prompt checked above.
    expect(mockPrompt).toHaveBeenCalled();
    const userPrompt = mockPrompt.mock.calls[0][0];
    expect(userPrompt).toContain("reason");
    expect(userPrompt).toContain("role");
    expect(userPrompt).toContain("symbols");
  });

  // -----------------------------------------------------------------------
  // Structured git changed-file details
  // -----------------------------------------------------------------------

  it("returns structured changedFileDetails from git_context summary in a real git repo", async () => {
    const repo = await makeGitRepo({
      "src/index.ts": "export const version = 1;\n",
      "src/lib.ts": "export const helper = true;\n",
    });

    // Modify a file and stage it
    await writeFile(join(repo, "src/index.ts"), "export const version = 2;\n// new line\n");
    execSync("git add src/index.ts", { cwd: repo, stdio: "pipe" });
    // Also modify it unstaged
    await writeFile(join(repo, "src/index.ts"), "export const version = 3;\n// another line\n");
    // Create an untracked file
    await writeFile(join(repo, "src/new.ts"), "export const newFile = true;\n");
    // Stage a deletion
    execSync("git rm src/lib.ts", { cwd: repo, stdio: "pipe" });

    await browseCodebase({
      input: "test git context",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
    const customTools = createCalls[0][0].customTools;
    const gitTool = customTools.find((tool) => tool.name === "git_context");
    const result = await gitTool.execute("tool-call", { action: "summary" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.changedFileDetails).toBeDefined();
    expect(payload.changedFileDetails.length).toBeGreaterThanOrEqual(3);

    // Check per-file detail structure
    const indexDetail = payload.changedFileDetails.find(
      (d: { path: string }) => d.path === "src/index.ts",
    );
    expect(indexDetail).toBeDefined();
    expect(indexDetail.staged).toBe(true);
    expect(indexDetail.unstaged).toBe(true);
    expect(indexDetail.untracked).toBe(false);
    expect(indexDetail.status).toBe("modified");

    const libDetail = payload.changedFileDetails.find(
      (d: { path: string }) => d.path === "src/lib.ts",
    );
    expect(libDetail).toBeDefined();
    expect(libDetail.staged).toBe(true);
    expect(libDetail.status).toBe("deleted");

    const newDetail = payload.changedFileDetails.find(
      (d: { path: string }) => d.path === "src/new.ts",
    );
    expect(newDetail).toBeDefined();
    expect(newDetail.untracked).toBe(true);
    expect(newDetail.staged).toBe(false);
    expect(newDetail.unstaged).toBe(false);
  });

  it("returns empty changedFileDetails for a clean git repository", async () => {
    const repo = await makeGitRepo({
      "src/index.ts": "export const ok = true;\n",
    });

    await browseCodebase({
      input: "test",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
    const customTools = createCalls[0][0].customTools;
    const gitTool = customTools.find((tool) => tool.name === "git_context");
    const result = await gitTool.execute("tool-call", { action: "summary" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.changedFileDetails).toBeUndefined();
    expect(payload.statusSummary).toBe("Working tree clean.");
  });

  it("handles renamed files in changedFileDetails", async () => {
    const repo = await makeGitRepo({
      "src/old.ts": "export const renamed = true;\n",
    });

    execSync("git mv src/old.ts src/renamed.ts", { cwd: repo, stdio: "pipe" });

    await browseCodebase({
      input: "test",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
    const customTools = createCalls[0][0].customTools;
    const gitTool = customTools.find((tool) => tool.name === "git_context");
    const result = await gitTool.execute("tool-call", { action: "summary" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.changedFileDetails).toBeDefined();
    // Rename can show as one detail with status "renamed" using new path
    const renamedDetail = payload.changedFileDetails.find(
      (d: { path: string }) => d.path === "src/renamed.ts",
    );
    expect(renamedDetail).toBeDefined();
    expect(renamedDetail.status).toBe("renamed");
    expect(renamedDetail.staged).toBe(true);
  });

  it("unquotes git porcelain paths with spaces in changedFileDetails and changedFiles", async () => {
    const repo = await makeGitRepo({
      "src/a b.ts": "export const spaced = 1;\n",
    });

    await writeFile(join(repo, "src/a b.ts"), "export const spaced = 2;\nexport const extra = true;\n");

    await browseCodebase({
      input: "test quoted path",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
    const customTools = createCalls[0][0].customTools;
    const gitTool = customTools.find((tool) => tool.name === "git_context");
    const result = await gitTool.execute("tool-call", { action: "summary" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.changedFiles).toContain("src/a b.ts");
    expect(payload.changedFiles).not.toContain('"src/a b.ts"');
    const spacedDetail = payload.changedFileDetails.find(
      (d: { path: string }) => d.path === "src/a b.ts",
    );
    expect(spacedDetail).toBeDefined();
    expect(spacedDetail.additions).toBeGreaterThan(0);
  });

  it("unquotes renamed git porcelain paths with spaces", async () => {
    const repo = await makeGitRepo({
      "src/old name.ts": "export const renamed = 1;\n",
    });

    execSync('git mv "src/old name.ts" "src/new name.ts"', { cwd: repo, stdio: "pipe" });

    await browseCodebase({
      input: "test quoted rename",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
    const customTools = createCalls[0][0].customTools;
    const gitTool = customTools.find((tool) => tool.name === "git_context");
    const result = await gitTool.execute("tool-call", { action: "summary" });
    const payload = JSON.parse(result.content[0].text);

    const renamedDetail = payload.changedFileDetails.find(
      (d: { path: string }) => d.path === "src/new name.ts",
    );
    expect(renamedDetail).toBeDefined();
    expect(renamedDetail.status).toBe("renamed");
  });

  it("rejects hallucinated changedFileDetails from scout gitContext when tool hasn't run", async () => {
    const repo = await makeGitRepo({
      "src/index.ts": "export const ok = true;\n",
    });

    // Scout returns hallucinated gitContext (including changedFileDetails)
    // but the git_context tool never runs in mock, so observedContext.gitSummary
    // stays undefined → sanitizeObservedGitContext returns undefined
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [{ path: "src/index.ts", score: 97, isEntrypoint: true }],
              gitContext: {
                branch: "fake-branch",
                changedFileDetails: [
                  { path: "src/fake.ts", status: "modified", staged: true, unstaged: false, untracked: false },
                  { path: "../../etc/passwd", status: "modified", staged: false, unstaged: true, untracked: false },
                  { path: "/abs/path.ts", status: "added", staged: true, unstaged: false, untracked: false },
                ],
              },
            }),
          },
        ],
      },
    ];

    const result = await browseCodebase({
      input: "test",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    // Without observed git context, hallucinated scout gitContext is discarded
    expect(result.gitContext).toBeUndefined();
    // The refs are still returned (the scout got those right via non-git tools)
    expect(result.refs).toHaveLength(1);
  });

  it("empty changedFileDetails[] in scout JSON signals git context request and preserves observed git summary when tool ran", async () => {
    const repo = await makeGitRepo({
      "src/index.ts": "export const ok = true;\n",
    });

    // Modify a file so observed git context has meaningful content
    await writeFile(join(repo, "src/index.ts"), "export const version = 2;\n// modified\n");

    // Scout returns gitContext with only an empty changedFileDetails array.
    // This signals "yes, I want git context" without providing actual details.
    mockSession.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              refs: [{ path: "src/index.ts", score: 97, isEntrypoint: true }],
              gitContext: {
                changedFileDetails: [],
              },
            }),
          },
        ],
      },
    ];

    // Simulate the git_context tool executing during the prompt session.
    // This populates observedContext.gitSummary with real git data.
    mockPrompt.mockImplementation(async () => {
      const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
      const customTools = createCalls[0][0].customTools;
      const gitTool = customTools.find((tool) => tool.name === "git_context");
      await gitTool.execute("tool-call", { action: "summary" });
    });

    const result = await browseCodebase({
      input: "test empty changedFileDetails",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    // The empty changedFileDetails array signals a git context request.
    // Since the git_context tool was observed, the real observed summary is used.
    expect(result.gitContext).toBeDefined();
    // Observed git data is present (not from scout)
    expect(result.gitContext?.branch).toBeDefined();
    expect(result.gitContext?.statusSummary).toBeDefined();
    // Only observed refs are present
    expect(result.refs).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Git status classification — xyToStatus for unstaged deletions and additions
  // -------------------------------------------------------------------------

  it("classifies unstaged working-tree deletion as deleted status", async () => {
    const repo = await makeGitRepo({
      "src/index.ts": "export const ok = true;\n",
    });

    // Create a file, commit it, then delete from working tree (not staged)
    await writeFile(join(repo, "src/to-delete.ts"), "export const temp = true;\n");
    execSync("git add src/to-delete.ts", { cwd: repo, stdio: "pipe" });
    execSync("git commit -m 'add to-delete'", { cwd: repo, stdio: "pipe" });
    // Unstaged deletion → porcelain shows " D"
    await rm(join(repo, "src/to-delete.ts"));

    await browseCodebase({
      input: "test git status",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
    const customTools = createCalls[0][0].customTools;
    const gitTool = customTools.find((tool) => tool.name === "git_context");
    const result = await gitTool.execute("tool-call", { action: "summary" });
    const payload = JSON.parse(result.content[0].text);

    const deletedDetail = payload.changedFileDetails.find(
      (d: { path: string }) => d.path === "src/to-delete.ts",
    );
    expect(deletedDetail).toBeDefined();
    expect(deletedDetail.status).toBe("deleted");
    expect(deletedDetail.staged).toBe(false);
    expect(deletedDetail.unstaged).toBe(true);
    expect(deletedDetail.untracked).toBe(false);
  });

  it("classifies intent-to-add file as added status", async () => {
    const repo = await makeGitRepo({
      "src/index.ts": "export const ok = true;\n",
    });

    // Create a new file and use git add -N for intent-to-add → porcelain shows " A"
    await writeFile(join(repo, "src/intent.ts"), "export const intent = true;\n");
    execSync("git add -N src/intent.ts", { cwd: repo, stdio: "pipe" });

    await browseCodebase({
      input: "test git status",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
    const customTools = createCalls[0][0].customTools;
    const gitTool = customTools.find((tool) => tool.name === "git_context");
    const result = await gitTool.execute("tool-call", { action: "summary" });
    const payload = JSON.parse(result.content[0].text);

    const addedDetail = payload.changedFileDetails.find(
      (d: { path: string }) => d.path === "src/intent.ts",
    );
    expect(addedDetail).toBeDefined();
    expect(addedDetail.status).toBe("added");
    expect(addedDetail.staged).toBe(false);
    expect(addedDetail.unstaged).toBe(true);
    expect(addedDetail.untracked).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Git diff truncation with maxLines / maxBytes
  // -------------------------------------------------------------------------

  it("truncates git diff output when maxLines or maxBytes limit is hit", async () => {
    const repo = await makeGitRepo({
      "src/index.ts": "export const ok = true;\n",
    });

    // Create a file with many lines, commit, then modify many lines
    const lines = Array.from({ length: 100 }, (_, i) => `export const line${i} = ${i};\n`).join("");
    await writeFile(join(repo, "src/big.ts"), lines);
    execSync("git add src/big.ts", { cwd: repo, stdio: "pipe" });
    execSync("git commit -m 'add big file'", { cwd: repo, stdio: "pipe" });
    // Modify all 100 lines to produce substantial diff
    const modifiedLines = Array.from({ length: 100 }, (_, i) => `export const line${i} = ${i * 2};\n`).join("");
    await writeFile(join(repo, "src/big.ts"), modifiedLines);

    await browseCodebase({
      input: "test git diff truncation",
      cwd: repo,
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read"],
    });

    const createCalls = mockCreateAgentSession.mock.calls as unknown as Array<[{ customTools: any[] }]>;
    const customTools = createCalls[0][0].customTools;
    const gitTool = customTools.find((tool) => tool.name === "git_context");
    // Use small limits to force truncation from both maxLines and maxBytes
    const result = await gitTool.execute("tool-call", {
      action: "diff",
      maxLines: 3,
      maxBytes: 200,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.truncated).toBe(true);
    expect(payload.diff).toContain("[truncated]");
    expect(payload.scope).toBe("working_tree");
  });
});

// ---------------------------------------------------------------------------
// Browse allowlist — tool safety boundary tests
// ---------------------------------------------------------------------------

describe("SAFE_BROWSE_TOOL_NAMES", () => {
  /**
   * These tests protect the read-only tool allowlist.
   * If a write, session-coupled, or network-heavy tool is added without
   * deliberate review, the equality test fails first. The negative tests
   * below are explicit documentation of which categories are excluded.
   */
  const EXPECTED_SAFE_TOOLS = new Set([
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

  function safeToolSet(): Set<string> {
    return new Set(SAFE_BROWSE_TOOL_NAMES);
  }

  it("is exposed as an immutable test-facing snapshot", () => {
    expect(Object.isFrozen(SAFE_BROWSE_TOOL_NAMES)).toBe(true);
  });

  it("is unchanged from the expected set (fails if tools are added/removed without review)", () => {
    // Structural guard: exact-set assertion forces deliberate review of any
    // change to the allowlist. The expected set is duplicated here so that
    // adding a new tool requires updating both the source constant AND this
    // test, making the change visible in review.
    expect(safeToolSet()).toEqual(EXPECTED_SAFE_TOOLS);
  });

  it("excludes write/edit tools", () => {
    for (const name of ["write", "edit"]) {
      expect(safeToolSet()).not.toContain(name);
    }
  });

  it("excludes session-coupled tools (these are internal bounded tools, not in the external allowlist)", () => {
    for (const name of ["session_history", "git_context"]) {
      expect(safeToolSet()).not.toContain(name);
    }
  });

  it("excludes shell/execution tools", () => {
    for (const name of [
      "bash",
      "shell",
      "execute",
      "run",
      "spawn",
      "command",
      "terminal",
    ]) {
      expect(safeToolSet()).not.toContain(name);
    }
  });

  it("excludes network-heavy tools", () => {
    for (const name of [
      "web",
      "web_search",
      "fetch",
      "curl",
      "wget",
      "http",
      "request",
    ]) {
      expect(safeToolSet()).not.toContain(name);
    }
  });

  it("excludes infrastructure/container tools", () => {
    for (const name of ["docker", "kubectl", "ssh", "helm"]) {
      expect(safeToolSet()).not.toContain(name);
    }
  });

  it("excludes package-manager tools", () => {
    for (const name of ["npm", "npx", "pnpm", "yarn", "pip"]) {
      expect(safeToolSet()).not.toContain(name);
    }
  });
});
