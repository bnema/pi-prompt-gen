/**
 * Tests for browse-pass.ts — isolated read-only browse session setup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

const { browseCodebase } = await import("../src/browse-pass.js");

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
});
