/**
 * Regression coverage for extension startup in OMP-compatible hosts.
 */

import { describe, expect, it, vi } from "vitest";

const registeredCommands = vi.hoisted((): Record<string, unknown> => ({}));

vi.mock("../src/browse-pass.js", () => {
  throw new Error("browse pass unavailable in host runtime");
});

vi.mock("../src/index.js", () => ({
  enhancePrompt: vi.fn(),
}));

vi.mock("../src/debug-artifact.js", () => ({
  buildMetadataSummaryParts: vi.fn(() => []),
}));

vi.mock("../src/modal.js", () => ({
  PromptGenModal: vi.fn().mockImplementation(function PromptGenModalMock() {
    return { bind: vi.fn() };
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  getAgentDir: vi.fn(() => `/tmp/pi-prompt-gen-extension-load-${process.pid}`),
  SettingsManager: {
    create: vi.fn(() => ({
      getEnabledModels: vi.fn(),
    })),
  },
}));

vi.mock("@earendil-works/pi-ai", () => ({}));

const { default: registerPiPromptGen } = await import("../extensions/index.js");

describe("extension startup", () => {
  it("registers /prompt when the optional browse pass is unavailable", () => {
    registerPiPromptGen({
      on: vi.fn(),
      registerCommand: vi.fn((name: string, command: unknown) => {
        registeredCommands[name] = command;
      }),
      registerShortcut: vi.fn(),
      getAllTools: vi.fn(() => []),
    } as never);

    expect("prompt" in registeredCommands).toBe(true);
  });
});
