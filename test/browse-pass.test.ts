/**
 * Tests for browse-pass.ts — isolated read-only browse session setup.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";

const mockSetRuntimeApiKey = vi.fn();
const mockRegisterProvider = vi.fn();
const mockReload = vi.fn().mockResolvedValue(undefined);
const mockAbort = vi.fn().mockResolvedValue(undefined);
const mockDispose = vi.fn();
const mockPrompt = vi.fn().mockResolvedValue(undefined);
const mockSubscribe = vi.fn(() => vi.fn());
const mockCreateAgentSession = vi.fn(async () => ({
  session: {
    subscribe: mockSubscribe,
    prompt: mockPrompt,
    abort: mockAbort,
    dispose: mockDispose,
    messages: [
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
    ],
  },
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
  DefaultResourceLoader: vi.fn().mockImplementation(function DefaultResourceLoaderMock() {
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

describe("browseCodebase", () => {
  beforeEach(() => {
    mockSetRuntimeApiKey.mockReset();
    mockRegisterProvider.mockReset();
    mockReload.mockClear();
    mockAbort.mockReset();
    mockDispose.mockReset();
    mockPrompt.mockReset();
    mockPrompt.mockResolvedValue(undefined);
    mockSubscribe.mockClear();
    mockCreateAgentSession.mockClear();
  });

  it("creates the isolated browse session with thinking disabled", async () => {
    const refs = await browseCodebase({
      input: "fix sidebar sorting",
      cwd: "/repo",
      model: makeModel(),
      apiKey: "sk-test",
      tools: ["read", "grep"],
    });

    expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      thinkingLevel: "off",
    }));
    expect(refs).toEqual([
      { path: "src/index.ts", score: 97, isEntrypoint: true },
    ]);
  });
});
