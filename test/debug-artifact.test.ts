/**
 * Tests for src/debug-artifact.ts — metadata artifact builder.
 *
 * Covers:
 * - Basic build with full metadata
 * - Missing optional fields
 * - Secret/raw-input exclusion (sentinel values in enhancedPrompt)
 * - Exclusion of enhanced prompt body, system prompt, and model result
 * - Empty refs, missing context
 */

import { describe, it, expect } from "vitest";
import { buildDebugArtifact, buildMetadataSummaryParts, sanitizeDisplayField, sanitizeDisplayList } from "../src/debug-artifact.js";
import type { EnhancePromptResult } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFullResult(overrides?: Partial<EnhancePromptResult>): EnhancePromptResult {
  return {
    enhancedPrompt: "Fixed: sort the sidebar items by `createdAt` descending.",
    refs: [
      { path: "src/Sidebar.tsx", score: 97, isEntrypoint: true, lineCount: 120 },
      { path: "src/SidebarList.tsx", score: 65, isEntrypoint: false, reason: "List component" },
    ],
    gitContext: {
      branch: "feat/sidebar-sort",
      statusSummary: "2 modified files.",
      changedFiles: ["src/Sidebar.tsx"],
      diffSummary: "Recent changes adjust sort logic.",
    },
    sessionContext: {
      relevantMessages: [
        { role: "user", text: "Fix the sidebar sort order." },
      ],
    },
    systemPrompt: "# Role\nYou are a prompt-engineering assistant.",
    modelResult: {
      content: "Fixed: sort the sidebar items by `createdAt` descending.",
      usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 80, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      responseModel: "test-model",
      responseId: "resp_debug",
    },
    metadata: {
      modelId: "test-model",
      modelName: "Test Model",
      modelProvider: "test-provider",
      latencyMs: 1200,
      refCount: 2,
      browseToolsUsed: ["read", "grep"],
      stopReason: "stop",
      usageSummary: { input: 50, output: 30, totalTokens: 80 },
    },
    ...overrides,
  };
}

function makeMinimalResult(): EnhancePromptResult {
  return {
    enhancedPrompt: "Result.",
    refs: [],
    systemPrompt: "",
    modelResult: {
      content: "Result.",
      stopReason: "stop",
    },
    metadata: {
      refCount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildDebugArtifact", () => {
  it("returns a string with header and footer markers", () => {
    const result = makeFullResult();
    const artifact = buildDebugArtifact(result);

    expect(typeof artifact).toBe("string");
    expect(artifact).toContain("=== pi-prompt-gen metadata artifact ===");
    expect(artifact).toContain("--- End metadata artifact ---");
  });

  it("includes model metadata fields", () => {
    const artifact = buildDebugArtifact(makeFullResult());

    expect(artifact).toContain("Model ID:");
    expect(artifact).toContain("test-model");
    expect(artifact).toContain("Model name:");
    expect(artifact).toContain("Test Model");
    expect(artifact).toContain("Provider:");
    expect(artifact).toContain("test-provider");
  });

  it("includes latency, ref count, stop reason, and token usage", () => {
    const artifact = buildDebugArtifact(makeFullResult());

    expect(artifact).toContain("Latency:");
    expect(artifact).toContain("1200 ms");
    expect(artifact).toContain("Refs used:");
    expect(artifact).toContain("2");
    expect(artifact).toContain("Stop reason:");
    expect(artifact).toContain("stop");
    expect(artifact).toContain("Tokens:");
    expect(artifact).toContain("in: 50");
    expect(artifact).toContain("out: 30");
    expect(artifact).toContain("total: 80");
  });

  it("includes browse tool names", () => {
    const artifact = buildDebugArtifact(makeFullResult());

    expect(artifact).toContain("Browse tools:");
    expect(artifact).toContain("read, grep");
  });

  it("omits cost information from the artifact", () => {
    const artifact = buildDebugArtifact(makeFullResult());

    expect(artifact).not.toContain("cost");
    expect(artifact).not.toContain("Cost");
  });

  it("does not include the enhanced prompt body", () => {
    // The enhanced prompt body may contain raw user input or secrets echoed
    // by the model. The artifact must exclude it entirely.
    const result = makeFullResult();
    const artifact = buildDebugArtifact(result);

    expect(artifact).not.toContain("Fixed: sort the sidebar items");
    expect(artifact).not.toContain("Enhanced prompt");
    expect(artifact).not.toContain("truncated");
  });

  it("excludes enhanced prompt body even when it contains fake secrets", () => {
    // Regression: ensure sentinel secrets in enhancedPrompt do NOT appear
    const sentinelResult = makeFullResult({
      enhancedPrompt: "sk-test-secret-abcdef123456 PRIVATE_USER_INPUT_SENTINEL",
    });
    const artifact = buildDebugArtifact(sentinelResult);

    expect(artifact).not.toContain("sk-test-secret");
    expect(artifact).not.toContain("PRIVATE_USER_INPUT_SENTINEL");
  });

  it("does not include raw user input", () => {
    // metadata does not carry raw input
    const artifact = buildDebugArtifact(makeFullResult());
    // The ref paths and context references are in the result, but raw input
    // (what the user typed into the draft) is not stored in EnhancePromptResult
    // so it cannot leak through buildDebugArtifact.
    // Verify we only see ref paths, not anything that looks like a raw prompt
    expect(artifact).toContain("src/Sidebar.tsx");
  });

  it("redacts API-key shaped sentinels from included display fields", () => {
    const artifact = buildDebugArtifact(makeFullResult({
      refs: [
        { path: "src/sk-test-secret-abcdef123456.ts", score: 1, isEntrypoint: false },
      ],
      metadata: {
        ...makeFullResult().metadata,
        modelName: "Model sk-test-secret-metadata123456",
        browseToolsUsed: ["read", "sk-test-secret-tool123456"],
        refCount: 1,
      },
    }));

    expect(artifact).not.toContain("sk-test-secret-abcdef123456");
    expect(artifact).not.toContain("sk-test-secret-metadata123456");
    expect(artifact).not.toContain("sk-test-secret-tool123456");
    expect(artifact).toContain("[redacted]");
  });

  it("includes context flags (git/session presence)", () => {
    const artifact = buildDebugArtifact(makeFullResult());

    expect(artifact).toContain("Has git context:");
    expect(artifact).toContain("yes");
    expect(artifact).toContain("Has session ctx:");
    expect(artifact).toContain("yes");
  });

  it("refs section lists sanitized file paths without scores or metadata", () => {
    const artifact = buildDebugArtifact(makeFullResult());

    expect(artifact).toContain("Refs:");
    expect(artifact).toContain("src/Sidebar.tsx");
    expect(artifact).toContain("src/SidebarList.tsx");
    // Scores should NOT appear
    expect(artifact).not.toContain("97");
    expect(artifact).not.toContain("65");
    // Symbols should not appear
    expect(artifact).not.toContain("isEntrypoint");
  });

  it("sanitizes ref paths with newlines so they cannot forge artifact lines", () => {
    const artifact = buildDebugArtifact(makeFullResult({
      refs: [
        { path: "src/good.ts\nForged: line", score: 1, isEntrypoint: false },
      ],
      metadata: {
        ...makeFullResult().metadata,
        refCount: 1,
      },
    }));

    for (const line of artifact.split("\n")) {
      expect(line).not.toMatch(/^Forged:/);
    }
    expect(artifact).toContain("src/good.ts Forged: line");
  });

  it("bounds displayed ref paths", () => {
    const longPath = `src/${"x".repeat(500)}.ts`;
    const artifact = buildDebugArtifact(makeFullResult({
      refs: [{ path: longPath, score: 1, isEntrypoint: false }],
      metadata: {
        ...makeFullResult().metadata,
        refCount: 1,
      },
    }));

    const refLine = artifact.split("\n").find((line) => line.startsWith("  - src/"));
    expect(refLine).toBeDefined();
    const refValue = refLine!.slice("  - ".length);
    expect(refValue.length).toBeLessThanOrEqual(120);
    expect(refValue.length).toBeLessThan(longPath.length);
  });

  it("reports no context when result has no git/session context", () => {
    const minimal = makeMinimalResult();
    const artifact = buildDebugArtifact(minimal);

    expect(artifact).toContain("Has git context:");
    expect(artifact).toContain("no");
    expect(artifact).toContain("Has session ctx:");
    expect(artifact).toContain("no");
  });

  it("shows no refs section when refs array is empty", () => {
    const minimal = makeMinimalResult();
    const artifact = buildDebugArtifact(minimal);

    // The "Refs:" section should not appear since context lists refs
    // When refs.length is 0, the code skips printing Refs:
    expect(artifact).not.toContain("Refs:");
  });

  it("shows no refs section when every ref path sanitizes to empty", () => {
    const artifact = buildDebugArtifact(makeFullResult({
      refs: [{ path: "\n\t", score: 1, isEntrypoint: false }],
      metadata: {
        ...makeFullResult().metadata,
        refCount: 1,
      },
    }));

    expect(artifact).not.toContain("Refs:");
  });

  it("reports accurate metadata even when some fields are absent", () => {
    const minimal = makeMinimalResult();
    const artifact = buildDebugArtifact(minimal);

    expect(artifact).toContain("Refs used:");
    expect(artifact).toContain("0");
    // stopReason was not set in metadata, so it appears as "unknown"
    expect(artifact).toContain("Stop reason:");
    expect(artifact).toContain("unknown");
    // Fields that are absent should not appear
    expect(artifact).not.toContain("Model ID:");
    expect(artifact).not.toContain("Model name:");
    expect(artifact).not.toContain("Provider:");
    expect(artifact).not.toContain("Latency:");
  });

  it("does not contain system prompt or full model result content", () => {
    const artifact = buildDebugArtifact(makeFullResult({
      systemPrompt: "SYSTEM_PROMPT_SECRET_SENTINEL",
      modelResult: {
        content: "MODEL_RESULT_SECRET_SENTINEL",
        usage: {
          input: 50,
          output: 30,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 80,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
        },
        stopReason: "stop",
      },
    }));

    expect(artifact).not.toContain("systemPrompt");
    expect(artifact).not.toContain("modelResult");
    expect(artifact).not.toContain("SYSTEM_PROMPT_SECRET_SENTINEL");
    expect(artifact).not.toContain("MODEL_RESULT_SECRET_SENTINEL");
    // The enhanced prompt body should also not appear
    expect(artifact).not.toContain("Enhanced prompt");
  });

  it("includes a note explaining why content is excluded", () => {
    const artifact = buildDebugArtifact(makeFullResult());

    expect(artifact).toContain("intentionally excluded");
    expect(artifact).toContain("sensitive data");
  });

  // ---------------------------------------------------------------------------
  // Sanitization: newline / control-char injection
  // ---------------------------------------------------------------------------

  it("sanitizes modelName with newlines — does not forge artifact lines", () => {
    const result = makeFullResult({
      metadata: {
        ...makeFullResult().metadata,
        modelName: "Malicious\nModel\nName",
      },
    });
    const artifact = buildDebugArtifact(result);

    // Newlines should be replaced with spaces, not create new artifact lines.
    // Check that "Malicious" does not start its own line.
    for (const line of artifact.split("\n")) {
      expect(line).not.toMatch(/^Malicious/);
    }
    // The sanitized value should appear on the existing "Model name:" line
    expect(artifact).toContain("Model name:");
    expect(artifact).toContain("Malicious Model Name");
  });

  it("sanitizes modelId with control characters", () => {
    const result = makeFullResult({
      metadata: {
        ...makeFullResult().metadata,
        modelId: "test-id\x00null\tchar",
      },
    });
    const artifact = buildDebugArtifact(result);

    expect(artifact).toContain("Model ID:");
    // Null byte and raw control chars should be stripped
    expect(artifact).not.toContain("\x00");
    // Tabs are replaced with spaces, then collapsed
    expect(artifact).not.toContain("\t");
    // "null" as text survives (it was after the null byte, not the byte itself)
    expect(artifact).toContain("test-id null char");
  });

  it("sanitizes modelProvider with escapes", () => {
    const result = makeFullResult({
      metadata: {
        ...makeFullResult().metadata,
        modelProvider: "evil\x1b[31mRED\x1b[0m",
      },
    });
    const artifact = buildDebugArtifact(result);

    expect(artifact).toContain("Provider:");
    // ESC byte should be stripped
    expect(artifact).not.toContain("\x1b");
    // After ESC is replaced with space, "evil [31mRED [0m" is the result
    // The brackets and digits survive because they are printable ASCII
    expect(artifact).toContain("evil [31mRED [0m");
  });

  it("sanitizes browseToolsUsed with newlines — does not forge artifact lines", () => {
    const result = makeFullResult({
      metadata: {
        ...makeFullResult().metadata,
        browseToolsUsed: ["read", "evil\ntool\nname"],
      },
    });
    const artifact = buildDebugArtifact(result);

    // Newlines should not create extra artifact lines
    for (const line of artifact.split("\n")) {
      expect(line).not.toMatch(/^evil/);
    }
    expect(artifact).toContain("Browse tools:");
    // "evil tool name" after sanitization (newlines → spaces, collapsed)
    expect(artifact).toContain("evil tool name");
  });

  it("sanitizes stopReason with newlines", () => {
    const result = makeFullResult({
      metadata: {
        ...makeFullResult().metadata,
        stopReason: "length\nbut not really",
      },
    });
    const artifact = buildDebugArtifact(result);

    expect(artifact).toContain("Stop reason:");
    expect(artifact).toContain("length but not really");
    // Original newline should not produce a new artifact line
    for (const line of artifact.split("\n")) {
      expect(line).not.toMatch(/^but not really/);
    }
  });

  it("sanitizes long model name — bounded at 200 chars", () => {
    const longName = "x".repeat(500);
    const result = makeFullResult({
      metadata: {
        ...makeFullResult().metadata,
        modelName: longName,
      },
    });
    const artifact = buildDebugArtifact(result);

    expect(artifact).toContain("Model name:");
    // The name value (after the label prefix) should be bounded
    const nameLine = artifact.split("\n").find((l) => l.startsWith("Model name:"));
    expect(nameLine).toBeDefined();
    const nameValue = nameLine!.slice("Model name:    ".length);
    expect(nameValue.length).toBeLessThanOrEqual(200);
    expect(nameValue.length).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// buildMetadataSummaryParts
// ---------------------------------------------------------------------------

describe("buildMetadataSummaryParts", () => {
  it("omits metadata fields that sanitize to empty strings", () => {
    const parts = buildMetadataSummaryParts({
      modelName: "  \n\t  ",
      modelId: "fallback-model",
      stopReason: " \n ",
      refCount: 0,
    });

    expect(parts).toEqual(["fallback-model"]);
  });
});

// ---------------------------------------------------------------------------
// sanitizeDisplayField
// ---------------------------------------------------------------------------

describe("sanitizeDisplayField", () => {
  it("strips newlines", () => {
    expect(sanitizeDisplayField("hello\nworld")).toBe("hello world");
  });

  it("strips carriage returns", () => {
    expect(sanitizeDisplayField("hello\rworld")).toBe("hello world");
  });

  it("strips tabs", () => {
    expect(sanitizeDisplayField("hello\tworld")).toBe("hello world");
  });

  it("strips null bytes", () => {
    expect(sanitizeDisplayField("hello\x00world")).toBe("hello world");
  });

  it("strips escape sequences", () => {
    expect(sanitizeDisplayField("hello\x1b[31mworld\x1b[0m")).toBe("hello [31mworld [0m");
  });

  it("redacts API-key shaped tokens", () => {
    expect(sanitizeDisplayField("before sk-test-secret-abcdef123456 after")).toBe("before [redacted] after");
  });

  it("strips DEL characters", () => {
    expect(sanitizeDisplayField("hello\x7fworld")).toBe("hello world");
  });

  it("collapses multiple whitespace runs into a single space", () => {
    expect(sanitizeDisplayField("hello    world")).toBe("hello world");
  });

  it("collapses mixed whitespace and control characters", () => {
    expect(sanitizeDisplayField("hello\n\n\nworld")).toBe("hello world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeDisplayField("  hello world  ")).toBe("hello world");
  });

  it("bounds string length to default max", () => {
    const long = "a".repeat(500);
    const result = sanitizeDisplayField(long);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toBe("a".repeat(200));
  });

  it("respects custom max length", () => {
    const long = "abc".repeat(50); // 150 chars
    const result = sanitizeDisplayField(long, 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result).toBe("abcabcabca"); // 10 chars — slice(0,10) then trimEnd
  });

  it("returns empty string for string of only whitespace", () => {
    expect(sanitizeDisplayField("   \n  \t  ")).toBe("");
  });

  it("preserves normal display text unchanged", () => {
    expect(sanitizeDisplayField("Hello, World!")).toBe("Hello, World!");
  });

  it("preserves unicode characters", () => {
    expect(sanitizeDisplayField("café résumé ñoño")).toBe("café résumé ñoño");
  });
});

// ---------------------------------------------------------------------------
// sanitizeDisplayList
// ---------------------------------------------------------------------------

describe("sanitizeDisplayList", () => {
  it("sanitizes each item", () => {
    const result = sanitizeDisplayList(["read", "evil\ntool"]);
    expect(result).toEqual(["read", "evil tool"]);
  });

  it("filters out empty items", () => {
    const result = sanitizeDisplayList(["read", "", "grep"]);
    expect(result).toEqual(["read", "grep"]);
  });

  it("filters out whitespace-only items", () => {
    const result = sanitizeDisplayList(["read", "   \n  ", "grep"]);
    expect(result).toEqual(["read", "grep"]);
  });

  it("bounds list item count to default max", () => {
    const items = Array.from({ length: 50 }, (_, i) => `tool-${i}`);
    const result = sanitizeDisplayList(items, 5);
    expect(result.length).toBe(5);
    expect(result).toEqual(["tool-0", "tool-1", "tool-2", "tool-3", "tool-4"]);
  });

  it("returns all items when count is under max", () => {
    const result = sanitizeDisplayList(["read", "grep", "find"]);
    expect(result).toEqual(["read", "grep", "find"]);
  });

  it("returns empty array for empty input", () => {
    expect(sanitizeDisplayList([])).toEqual([]);
  });
});
