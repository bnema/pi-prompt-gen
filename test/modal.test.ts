/**
 * Tests for src/modal.ts — PromptGenModal overlay component.
 *
 * Covers:
 *  - Modal construction with various option combinations
 *  - Mode auto-detection (rewrite when prefilled, generate when blank)
 *  - Text editing operations (insert, backspace, delete, cursor navigation)
 *  - Actions: copy, apply, send, clear, close
 *  - Regenerate / Alternative (Alt+r) issues a fresh isolated request
 *  - Enhancement status lifecycle (idle → enhancing → enhanced / error)
 *  - Mode toggle (Alt+m)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PromptGenModal, type PromptGenModalOptions, type PromptGenModalResult } from "../src/modal.js";
import type { EnhancePromptResult } from "../src/index.js";

// ---------------------------------------------------------------------------
// Mock theme helpers
// ---------------------------------------------------------------------------

/**
 * A tracking theme that wraps every styled string with a marker so tests
 * can assert that specific text was routed through a given color slot.
 */
function makeTrackingTheme(): Theme & { calls: Array<{ color: string; text: string }> } {
  const calls: Array<{ color: string; text: string }> = [];
  const wrap = (color: string, text: string) => {
    calls.push({ color, text });
    return text;
  };
  return {
    fg: (color: string, text: string) => wrap(color, text),
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    dim: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    calls,
  } as unknown as Theme & { calls: Array<{ color: string; text: string }> };
}

function makeTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    dim: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
  } as unknown as Theme;
}

function makeEnhanceResult(overrides?: Partial<EnhancePromptResult>): EnhancePromptResult {
  return {
    enhancedPrompt: "Enhanced: fix the sidebar sort order to use `createdAt` descending.",
    refs: [{ path: "src/Sidebar.tsx", score: 65, isEntrypoint: true, lineCount: 120 }],
    systemPrompt: "# Role\nYou are a prompt-engineering assistant.",
    modelResult: {
      content: "Enhanced: fix the sidebar sort order to use `createdAt` descending.",
      usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 80, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      responseModel: "test-model",
    },
    metadata: {
      modelId: "test-model",
      modelName: "Test Model",
      modelProvider: "test-provider",
      latencyMs: 800,
      refCount: 1,
      stopReason: "stop",
      usageSummary: { input: 50, output: 30, totalTokens: 80 },
    },
    ...overrides,
  };
}

function makeModalOptions(overrides?: Partial<PromptGenModalOptions>): PromptGenModalOptions {
  return {
    initialText: "fix the sidebar sort",
    mode: "rewrite",
    enhanceFn: vi.fn().mockResolvedValue(makeEnhanceResult()),
    copyFn: vi.fn().mockResolvedValue(undefined),
    applyFn: vi.fn(),
    sendFn: vi.fn(),
    notifyFn: vi.fn(),
    ...overrides,
  };
}

/** Bind the modal and simulate the custom() factory wiring. */
function bindModal(modal: PromptGenModal, requestRender?: () => void, done?: (result: PromptGenModalResult | undefined) => void): void {
  modal.bind(
    makeTheme(),
    done ?? vi.fn(),
    requestRender ?? vi.fn(),
  );
}

// ---------------------------------------------------------------------------
// Helpers for manipulating the modal
// ---------------------------------------------------------------------------

/** Simulate a keypress on the modal. */
function press(modal: PromptGenModal, key: string): void {
  modal.handleInput(key);
}

/** Simulate typing a string (each character as key). */
function type(modal: PromptGenModal, text: string): void {
  for (const ch of text) {
    press(modal, ch);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PromptGenModal construction", () => {
  it("creates a modal with default options", () => {
    const modal = new PromptGenModal(makeModalOptions());
    bindModal(modal);
    expect(modal).toBeTruthy();
    // Should be renderable
    const lines = modal.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("starts in rewrite mode when prefilled text is provided", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "some prompt text", mode: undefined }));
    bindModal(modal);
    const lines = modal.render(80);
    const joined = lines.join("\n");
    // Should show rewrite mode indicator
    expect(joined).toContain("rewrite");
  });

  it("starts in generate mode when blank", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "", mode: undefined }));
    bindModal(modal);
    const lines = modal.render(80);
    const joined = lines.join("\n");
    expect(joined).toContain("generate");
  });

  it("does not show the blank prefill label in the header", () => {
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "",
      initialTextLabel: "blank",
      mode: "generate",
    }));
    bindModal(modal);

    expect(modal.render(80).join("\n")).not.toContain("(blank)");
  });

  it("auto-detects rewrite when initialText is non-empty", () => {
    // Mode auto-detection logic is in PromptGenModal constructor:
    // mode = options.mode ?? (draft.trim() ? "rewrite" : "generate")
    const modal = new PromptGenModal(makeModalOptions({ initialText: "hello", mode: undefined }));
    bindModal(modal);
    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("rewrite");
  });

  it("auto-detects generate when initialText is empty", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "", mode: undefined }));
    bindModal(modal);
    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("generate");
  });
});

describe("PromptGenModal mode toggle", () => {
  it("toggles mode on Alt+m", () => {
    const modal = new PromptGenModal(makeModalOptions({ mode: "rewrite" }));
    bindModal(modal);

    // Initial: rewrite
    expect(modal.render(80).join("\n")).toContain("rewrite");

    // Toggle to generate
    press(modal, "\u001bm"); // Alt+m
    expect(modal.render(80).join("\n")).toContain("generate");

    // Toggle back to rewrite
    press(modal, "\u001bm"); // Alt+m
    expect(modal.render(80).join("\n")).toContain("rewrite");
  });
});

describe("PromptGenModal text editing", () => {
  it("starts with the provided initial text", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "hello world" }));
    bindModal(modal);

    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("hello world");
  });

  it("inserts printable characters at cursor", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "" }));
    bindModal(modal);

    type(modal, "abc");
    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("abc");
  });

  it("reflects live draft updates after an initial render", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "" }));
    bindModal(modal);

    // Seed any render cache / first-frame state.
    modal.render(80);

    type(modal, "abc");
    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("abc");
  });

  it("accepts printable text chunks longer than one character", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "draft" }));
    bindModal(modal);

    modal.render(80);
    press(modal, " + pasted chunk");

    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("draft + pasted chunk");
  });

  it("preserves bracketed paste content after initial render without retriggering initial prefill", () => {
    const enhanceFn = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "existing draft",
      enhanceFn,
    }));
    bindModal(modal);

    modal.render(80);
    press(modal, "\u001b[200~ + pasted line 1\npasted line 2\u001b[201~");

    const joined = modal.render(80).join("\n");
    expect(joined).toContain("existing draft + pasted line 1");
    expect(joined).toContain("pasted line 2");
    expect(enhanceFn).not.toHaveBeenCalled();
  });

  it("backspace removes character before cursor", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "abc" }));
    bindModal(modal);

    // Move to end is default, press backspace 2x
    press(modal, "\x7f"); // backspace → "ab"
    press(modal, "\x7f"); // backspace → "a"

    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("a");
    expect(lines.join("\n")).not.toContain("abc");
  });

  it("Shift+Enter inserts a newline", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "line1" }));
    bindModal(modal);

    // Shift+Enter to insert newline after "line1"
    press(modal, "\u001b[13;2u"); // Shift+Enter (Kitty CSI-u)

    type(modal, "line2");

    const lines = modal.render(80);
    const text = lines.join("\n");
    expect(text).toContain("line1");
    expect(text).toContain("line2");
  });

  it("Enter does NOT insert a newline (triggers enhancement instead)", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult());
    const modal = new PromptGenModal(makeModalOptions({ initialText: "test", enhanceFn }));
    const renderSpy = vi.fn();
    bindModal(modal, renderSpy);

    // Press Enter
    press(modal, "\r");

    // The enhanceFn should have been called
    expect(enhanceFn).toHaveBeenCalledTimes(1);
    expect(enhanceFn).toHaveBeenCalledWith("test", "rewrite", expect.any(AbortSignal), undefined, expect.any(Function));
  });

  it("handles arrow key navigation", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "abc\ndef" }));
    bindModal(modal);

    // Default cursor is at end (after 'f')
    // Press up to go to the "abc" line
    press(modal, "\u001b[A"); // up arrow

    // Press left to move cursor left
    press(modal, "\u001b[D"); // left arrow

    // Insert char
    type(modal, "X");

    const lines = modal.render(80);
    // The text should show "abX" (cursor marker splits the line)
    expect(lines.join("\n")).toContain("abX");
    expect(lines.join("\n")).toContain("def");
  });

  it("supports Home and End navigation", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "hello world" }));
    bindModal(modal);

    // Home should go to start of line
    press(modal, "\u001b[H"); // home

    // Insert at start
    type(modal, ">");

    // The line should contain '>' and 'hello world' (cursor ▌ sits between > and h)
    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("hello world");
    expect(lines.join("\n")).toContain(">");
  });

  it("Delete removes character at cursor", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "abcd" }));
    bindModal(modal);

    // Home → cursor at start
    press(modal, "\u001b[H"); // home
    press(modal, "\u001b[3~"); // delete → removes 'a'

    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("bcd");
    expect(lines.join("\n")).not.toContain("abcd");
  });

  it("Ctrl+U clears the draft", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "hello world" }));
    bindModal(modal);

    press(modal, "\x15"); // Ctrl+U

    const lines = modal.render(80);
    expect(lines.join("\n")).not.toContain("hello world");
  });
});

describe("PromptGenModal enhancement lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls enhanceFn on Enter", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult());
    const onEnhanceResult = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "fix the sort",
      enhanceFn,
      onEnhanceResult,
    }));
    const renderSpy = vi.fn();
    bindModal(modal, renderSpy);

    press(modal, "\r");

    await vi.runAllTimersAsync();
    await vi.waitFor(() => {
      expect(enhanceFn).toHaveBeenCalledTimes(1);
      expect(enhanceFn).toHaveBeenCalledWith("fix the sort", "rewrite", expect.any(AbortSignal), undefined, expect.any(Function));
      expect(onEnhanceResult).toHaveBeenCalled();
    });

    // After enhancement, the result preview should be shown
    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("Enhanced");
  });

  it("shows status changes during enhancement lifecycle", async () => {
    // Use a promise we control to observe intermediate state
    let resolvePromise!: (val: EnhancePromptResult) => void;
    const enhanceFn = vi.fn().mockReturnValue(new Promise<EnhancePromptResult>((resolve) => {
      resolvePromise = resolve;
    }));
    const renderSpy = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal, renderSpy);

    // Start enhancement
    press(modal, "\r");

    // Should be in enhancing state
    expect(renderSpy).toHaveBeenCalled();

    // Resolve the enhancement
    resolvePromise(makeEnhanceResult());
    await vi.runAllTimersAsync();

    // After resolution, status should be 'enhanced'
    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("enhanced");
  });

  it("animates a spinner while enhancement is running", async () => {
    let resolvePromise!: (val: EnhancePromptResult) => void;
    const enhanceFn = vi.fn().mockReturnValue(new Promise<EnhancePromptResult>((resolve) => {
      resolvePromise = resolve;
    }));
    const renderSpy = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal, renderSpy);

    press(modal, "\r");

    const firstRender = modal.render(80).join("\n");
    const initialRenderCalls = renderSpy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(150);

    const secondRender = modal.render(80).join("\n");
    expect(renderSpy.mock.calls.length).toBeGreaterThan(initialRenderCalls);
    expect(secondRender).not.toBe(firstRender);

    resolvePromise(makeEnhanceResult());
    await vi.runAllTimersAsync();
  });

  it("shows browse progress lines while examining the codebase", async () => {
    let resolvePromise!: (val: EnhancePromptResult) => void;
    const enhanceFn = vi.fn().mockImplementation(async (_text, _mode, _signal, _previousOutput, onProgress) => {
      onProgress?.("Examining codebase…");
      onProgress?.("Reading src/index.ts…");
      return await new Promise<EnhancePromptResult>((resolve) => {
        resolvePromise = resolve;
      });
    });
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal, vi.fn());

    press(modal, "\r");

    const joined = modal.render(80).join("\n");
    expect(joined).toContain("Examining codebase…");
    expect(joined).toContain("Reading src/index.ts…");

    resolvePromise(makeEnhanceResult());
    await vi.runAllTimersAsync();
  });

  it("ignores bracketed paste while enhancement is in progress", async () => {
    let resolvePromise!: (val: EnhancePromptResult) => void;
    const enhanceFn = vi.fn().mockImplementation(async () => {
      return await new Promise<EnhancePromptResult>((resolve) => {
        resolvePromise = resolve;
      });
    });
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal, vi.fn());

    press(modal, "\r");
    press(modal, "\u001b[200~ + pasted while enhancing\u001b[201~");

    const joinedWhileEnhancing = modal.render(80).join("\n");
    expect(joinedWhileEnhancing).toContain("test");
    expect(joinedWhileEnhancing).not.toContain("pasted while enhancing");

    resolvePromise(makeEnhanceResult());
    await vi.runAllTimersAsync();

    const joinedAfter = modal.render(80).join("\n");
    expect(joinedAfter).toContain("test");
    expect(joinedAfter).not.toContain("pasted while enhancing");
  });

  it("normalizes multiline progress messages to a single rendered line", async () => {
    let resolvePromise!: (val: EnhancePromptResult) => void;
    const enhanceFn = vi.fn().mockImplementation(async (_text, _mode, _signal, _previousOutput, onProgress) => {
      onProgress?.("Reading src/index.ts…\nextra detail");
      return await new Promise<EnhancePromptResult>((resolve) => {
        resolvePromise = resolve;
      });
    });
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal, vi.fn());

    press(modal, "\r");

    const joined = modal.render(80).join("\n");
    expect(joined).toContain("Reading src/index.ts… extra detail");
    expect(joined).not.toContain("Reading src/index.ts…\nextra detail");

    resolvePromise(makeEnhanceResult());
    await vi.runAllTimersAsync();
  });

  it("ignores late progress updates after the request is aborted", async () => {
    let resolvePromise!: (val: EnhancePromptResult) => void;
    let progress!: (message: string) => void;
    const enhanceFn = vi.fn().mockImplementation(async (_text, _mode, _signal, _previousOutput, onProgress) => {
      progress = onProgress!;
      return await new Promise<EnhancePromptResult>((resolve) => {
        resolvePromise = resolve;
      });
    });
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal, vi.fn());

    press(modal, "\r");
    progress("Reading src/index.ts…");
    expect(modal.render(80).join("\n")).toContain("Reading src/index.ts…");

    press(modal, "\u001b");
    progress("Stale progress should be ignored");

    const joined = modal.render(80).join("\n");
    expect(joined).toContain("cancelled");
    expect(joined).not.toContain("Stale progress should be ignored");

    resolvePromise(makeEnhanceResult());
    await Promise.resolve();
  });

  it("replaces stale progress lines when a new enhancement run starts", async () => {
    const progressCallbacks: Array<(message: string) => void> = [];
    const resolvers: Array<(val: EnhancePromptResult) => void> = [];
    const enhanceFn = vi.fn().mockImplementation(async (_text, _mode, _signal, _previousOutput, onProgress) => {
      progressCallbacks.push(onProgress!);
      return await new Promise<EnhancePromptResult>((resolve) => {
        resolvers.push(resolve);
      });
    });
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal, vi.fn());

    press(modal, "\r");
    progressCallbacks[0]!("Reading old-file.ts…");
    press(modal, "\u001b");

    press(modal, "\r");
    progressCallbacks[1]!("Reading fresh-file.ts…");

    const joined = modal.render(80).join("\n");
    expect(joined).toContain("Reading fresh-file.ts…");
    expect(joined).not.toContain("Reading old-file.ts…");

    resolvers[0]!(makeEnhanceResult());
    resolvers[1]!(makeEnhanceResult());
    await Promise.resolve();
  });

  it("handles enhancement errors gracefully", async () => {
    const enhanceFn = vi.fn().mockRejectedValue(new Error("API error"));
    const notifyFn = vi.fn();
    const renderSpy = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
      notifyFn,
    }));
    bindModal(modal, renderSpy);

    press(modal, "\r");

    // Wait for promise rejection to be handled
    await vi.waitFor(() => {
      // After the error, the status should be 'error'
      const lines = modal.render(80);
      const joined = lines.join("\n");
      expect(joined).toContain("error");
    });
  });
});

describe("PromptGenModal actions", () => {
  it("copyFn is called on Alt+y", async () => {
    const copyFn = vi.fn().mockResolvedValue(undefined);
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult({
      enhancedPrompt: "Enhanced output",
    }));
    const enhancedModal = new PromptGenModal(makeModalOptions({
      initialText: "test prompt",
      enhanceFn,
      copyFn,
    }));
    const renderSpy = vi.fn();
    bindModal(enhancedModal, renderSpy);

    // Run enhancement first
    press(enhancedModal, "\r");
    await vi.waitFor(() => {
      const lines = enhancedModal.render(80);
      expect(lines.join("\n")).toContain("Enhanced output");
    });

    // Copy
    press(enhancedModal, "\u001by"); // Alt+y
    await vi.waitFor(() => {
      expect(copyFn).toHaveBeenCalledWith("Enhanced output");
    });
  });

  it("applyFn requires enhanced result on Alt+a", async () => {
    const applyFn = vi.fn();
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult({
      enhancedPrompt: "Enhanced output",
    }));
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      applyFn,
      enhanceFn,
    }));
    const renderSpy = vi.fn();
    bindModal(modal, renderSpy);

    // Enhance first
    press(modal, "\r");
    await vi.waitFor(() => {
      const lines = modal.render(80);
      expect(lines.join("\n")).toContain("Enhanced output");
    });

    // Alt+a should apply the enhanced result, not the draft
    press(modal, "\u001ba"); // Alt+a
    expect(applyFn).toHaveBeenCalledWith("Enhanced output");
  });

  it("sendFn requires enhanced result on Alt+s", async () => {
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult({
      enhancedPrompt: "Enhanced to send",
    }));
    const done = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
      sendFn,
    }));
    const renderSpy = vi.fn();
    bindModal(modal, renderSpy, done);

    // Enhance first
    press(modal, "\r");
    await vi.waitFor(() => {
      const lines = modal.render(80);
      expect(lines.join("\n")).toContain("Enhanced to send");
    });

    // Alt+s should send and close
    press(modal, "\u001bs"); // Alt+s
    await vi.waitFor(() => {
      expect(sendFn).toHaveBeenCalledWith("Enhanced to send");
      // Modal should close on successful send
      expect(done).toHaveBeenCalledWith(expect.objectContaining({
        draftText: "test",
      }));
    });
  });

  it("done is called with result on Escape", () => {
    const done = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
    }));
    bindModal(modal, vi.fn(), done);

    press(modal, "\u001b"); // Escape
    expect(done).toHaveBeenCalledWith({
      draftText: "test",
      lastResult: undefined,
    });
  });

  it("clear (Alt+c) clears the draft", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "hello" }));
    bindModal(modal);

    press(modal, "\u001bc"); // Alt+c

    // Draft text should be empty
    const lines = modal.render(80);
    expect(lines.join("\n")).not.toContain("hello");
  });

  it("editing after enhancement invalidates stale result so apply notifies", async () => {
    const applyFn = vi.fn();
    const notifyFn = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "hello",
      applyFn,
      notifyFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      expect(modal.render(80).join("\n")).toContain("Enhanced");
    });

    type(modal, "!");
    // After editing, stale result is cleared
    expect(modal.render(80).join("\n")).not.toContain("Enhanced");

    // Apply should notify instead of silently using draft
    press(modal, "\u001ba"); // Alt+a
    expect(applyFn).not.toHaveBeenCalled();
    expect(notifyFn).toHaveBeenCalledWith(
      "No enhanced result to apply. Enhance draft first.",
      "warning",
    );
  });
});

describe("PromptGenModal regenerate/alternative", () => {
  it("Alt+r calls enhanceFn fresh each time", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult());
    const onEnhanceResult = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test regenerate",
      enhanceFn,
      onEnhanceResult,
    }));
    const renderSpy = vi.fn();
    bindModal(modal, renderSpy);

    // First enhancement via Enter
    press(modal, "\r");
    await vi.waitFor(() => {
      expect(enhanceFn).toHaveBeenCalledTimes(1);
    });

    // Regenerate via Alt+r
    press(modal, "\u001br"); // Alt+r
    await vi.waitFor(() => {
      // Called again with same text and the previous output as a variation hint
      expect(enhanceFn).toHaveBeenCalledTimes(2);
      expect(enhanceFn).toHaveBeenLastCalledWith(
        "test regenerate",
        "rewrite",
        expect.any(AbortSignal),
        "Enhanced: fix the sidebar sort order to use `createdAt` descending.",
        expect.any(Function),
      );
    });
  });

  it("regenerate with blank draft shows warning", () => {
    const notifyFn = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "",
      notifyFn,
    }));
    bindModal(modal);

    press(modal, "\u001br"); // Alt+r
    expect(notifyFn).toHaveBeenCalledWith(
      "Nothing to enhance — type something first.",
      "warning",
    );
  });
});

describe("PromptGenModal Escape behavior", () => {
  it("Escape closes modal when idle", () => {
    const done = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({ initialText: "test" }));
    bindModal(modal, vi.fn(), done);

    press(modal, "\u001b"); // Escape
    expect(done).toHaveBeenCalled();
  });

  it("Escape during enhancement aborts and returns to idle", async () => {
    let resolvePromise!: (val: EnhancePromptResult) => void;
    const enhanceFn = vi.fn().mockReturnValue(new Promise<EnhancePromptResult>((resolve) => {
      resolvePromise = resolve;
    }));
    const renderSpy = vi.fn();
    const done = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal, renderSpy, done);

    // Start enhancement
    press(modal, "\r");
    expect(renderSpy).toHaveBeenCalled();

    // Escape during enhancement - should abort, not close
    press(modal, "\u001b");
    expect(done).not.toHaveBeenCalled(); // not closed

    // Late resolution of the aborted request must not update the preview
    resolvePromise(makeEnhanceResult({ enhancedPrompt: "stale output" }));
    await Promise.resolve();

    // Status should show cancellation and stale output should be ignored
    const lines = modal.render(80);
    expect(lines.join("\n")).toContain("cancelled");
    expect(lines.join("\n")).not.toContain("stale output");
  });
});

describe("PromptGenModal render output", () => {
  it("renders title and frame", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "hello" }));
    bindModal(modal);

    const lines = modal.render(80);
    const joined = lines.join("\n");
    expect(joined).toContain("/prompt");
    expect(joined).toContain("╭");
    expect(joined).toContain("╰");
  });

  it("shows two help lines with labeled shortcuts", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "hello" }));
    bindModal(modal);

    const joined = modal.render(80).join("\n");
    // When idle (no result yet), show primary action help
    expect(joined).toContain("[Enter] Enhance");
    expect(joined).toContain("[Alt+M] Mode");
    expect(joined).toContain("[Alt+C] Clear");
    expect(joined).toContain("[Esc] Close");
    // Secondary actions still shown
    expect(joined).toContain("[Alt+R] Regenerate");
    expect(joined).toContain("[Alt+Y] Copy");
    expect(joined).toContain("[Alt+E] Meta");
    expect(joined).toContain("[Alt+A] Apply");
    expect(joined).toContain("[Alt+S] Send");
  });

  it("shows re-enhance help after enhancement", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult());
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const lines = modal.render(80);
      const joined = lines.join("\n");
      // After enhancement, show result-focused actions
      expect(joined).toContain("[Enter] Re-enhance");
      expect(joined).toContain("[Alt+R] Alternative");
      expect(joined).toContain("[Alt+Y] Copy");
      expect(joined).toContain("[Alt+E] Meta");
      expect(joined).toContain("[Alt+A] Apply");
      expect(joined).toContain("[Alt+S] Send");
    });
  });

  it("shows labeled Draft and Result pane separators", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "hello" }));
    bindModal(modal);

    const joined = modal.render(80).join("\n");
    expect(joined).toContain("── Draft ");
    expect(joined).toContain("── Result ");
  });

  it("shows mode-specific microcopy (refine a prompt / idea → prompt)", () => {
    const rewriteModal = new PromptGenModal(makeModalOptions({ mode: "rewrite" }));
    bindModal(rewriteModal);
    expect(rewriteModal.render(80).join("\n")).toContain("refine a prompt");

    const generateModal = new PromptGenModal(makeModalOptions({ initialText: "", mode: "generate" }));
    bindModal(generateModal);
    expect(generateModal.render(80).join("\n")).toContain("idea");
    expect(generateModal.render(80).join("\n")).toContain("prompt");
  });

  it("shows prefill source label when provided", () => {
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      initialTextLabel: "from args",
    }));
    bindModal(modal);

    const joined = modal.render(80).join("\n");
    expect(joined).toContain("(from args)");
  });

  it("shows truncation warning when result exceeds preview height", async () => {
    const longPrompt = Array.from({ length: 15 }, (_, i) => `Line ${i + 1} of a long result.`).join("\n");
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult({
      enhancedPrompt: longPrompt,
    }));
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "long prompt",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const joined = modal.render(80).join("\n");
      expect(joined).toContain("5 more lines");
      expect(joined).toContain("actions use full result");
    });
  });

  it("renders structured output (Goal/Context/Constraints/Verification sections) in preview within truncation bounds", async () => {
    // 12 lines: first 10 visible, last 2 overflow → truncation message
    const structuredPrompt = [
      "Goal:",
      "  Add a POST /api/users endpoint.",
      "Context:",
      "  src/api/routes/users.ts defines the route structure.",
      "Constraints:",
      "  - Validate email format.",
      "  - Hash password.",
      "Verification:",
      "  - Returns 201 on success.",
      "  - Rejects invalid email.",
      "  - Password field excluded.",
      "  - Duplicate email returns 409.",
    ].join("\n");
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult({
      enhancedPrompt: structuredPrompt,
    }));
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "add post users endpoint with validation",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const lines = modal.render(80);
      const joined = lines.join("\n");

      // Section headers within preview height (10 lines):
      // Goal: (line 1), Context: (line 3), Constraints: (line 5), Verification: (line 8)
      expect(joined).toContain("Goal:");
      expect(joined).toContain("Context:");
      expect(joined).toContain("Constraints:");
      expect(joined).toContain("Verification:");

      // Content from each section visible
      expect(joined).toContain("POST /api/users");
      expect(joined).toContain("route structure");
      expect(joined).toContain("Validate email");
      expect(joined).toContain("Returns 201");

      // Truncation for lines beyond preview (12 total − 10 visible = 2 overflow)
      expect(joined).toContain("2 more lines");
      expect(joined).toContain("actions use full result");
    });
  });

  it("shows result metadata with ref count and line count", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult({
      refs: [{ path: "src/Sidebar.tsx", score: 65, isEntrypoint: true, lineCount: 120 }],
      enhancedPrompt: "Enhanced result with a few words.",
    }));
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "sidebar sort",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const lines = modal.render(80);
      const joined = lines.join("\n");
      // Metadata shows ref count and line count
      expect(joined).toContain("●");
      expect(joined).toContain("1 ref");
      expect(joined).toContain("·");
      expect(joined).toContain("1 line");
    });
  });

  it("shows metadata without refs when result has no refs", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult({
      refs: [],
      enhancedPrompt: "Short result.",
    }));
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const lines = modal.render(80);
      const joined = lines.join("\n");
      // Metadata shows just line count when no refs
      expect(joined).toContain("1 line");
      // No ref bullet
      expect(joined).not.toContain("●");
    });
  });

  it("shows model name in metadata line", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult());
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const joined = modal.render(80).join("\n");
      // Model name from makeEnhanceResult metadata
      expect(joined).toContain("Test Model");
    });
  });

  it("shows stop reason in metadata line", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult());
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const joined = modal.render(80).join("\n");
      expect(joined).toContain("stop");
    });
  });

  it("shows token count in metadata line", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult());
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const joined = modal.render(80).join("\n");
      expect(joined).toContain("80 tok");
    });
  });

  it("shows latency in metadata line", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult());
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const joined = modal.render(80).join("\n");
      expect(joined).toContain("0.8s");
    });
  });

  it("metadata line gracefully omits fields when metadata fields are absent", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult({
      refs: [],
      enhancedPrompt: "No metadata.",
      metadata: {
        refCount: 0,
      },
    }));
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const joined = modal.render(80).join("\n");
      // Should still show line count even without model/tokens/latency
      expect(joined).toContain("1 line");
      // No model name
      expect(joined).not.toContain("Test Model");
      expect(joined).not.toContain("tok");
      // No latency (would appear as X.Xs)
      expect(joined).not.toMatch(/\d\.\ds/);
    });
  });

  it("uses modelId as fallback when modelName is absent in metadata", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult({
      refs: [],
      enhancedPrompt: "Result.",
      metadata: {
        modelId: "custom-model-id",
        refCount: 0,
        stopReason: "stop",
        usageSummary: { input: 10, output: 5 },
      },
    }));
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      const joined = modal.render(80).join("\n");
      // Falls back to modelId when modelName is absent
      expect(joined).toContain("custom-model-id");
    });
  });

  it("Alt+e copies debug artifact to clipboard", async () => {
    const copyFn = vi.fn().mockResolvedValue(undefined);
    const notifyFn = vi.fn();
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult());
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      enhanceFn,
      copyFn,
      notifyFn,
    }));
    bindModal(modal);

    press(modal, "\r");
    await vi.waitFor(() => {
      expect(modal.render(80).join("\n")).toContain("Enhanced");
    });

    press(modal, "\u001be"); // Alt+e
    await vi.waitFor(() => {
      expect(copyFn).toHaveBeenCalledTimes(1);
      const artifact = copyFn.mock.calls[0][0];
      expect(typeof artifact).toBe("string");
      expect(artifact).toContain("=== pi-prompt-gen metadata artifact ===");
      expect(artifact).toContain("Model");
      expect(artifact).toContain("Test Model");
      // Debug artifact shows total in Tokens table, not as "80 tok"
      expect(artifact).toContain("total: 80");
      expect(artifact).not.toContain("sk-");
    });
    expect(notifyFn).toHaveBeenCalledWith("Metadata artifact copied to clipboard.", "info");
  });

  it("Alt+e without enhancement shows warning", async () => {
    const copyFn = vi.fn();
    const notifyFn = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "test",
      copyFn,
      notifyFn,
    }));
    bindModal(modal);

    press(modal, "\u001be"); // Alt+e
    expect(notifyFn).toHaveBeenCalledWith(
      "No enhanced result to export. Enhance draft first.",
      "warning",
    );
    expect(copyFn).not.toHaveBeenCalled();
  });
});

describe("PromptGenModal result notifications", () => {
  it("notifies when trying to copy without enhancement", () => {
    const notifyFn = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "",
      notifyFn,
    }));
    bindModal(modal);

    press(modal, "\u001by"); // Alt+y (copy)
    expect(notifyFn).toHaveBeenCalledWith("No enhanced result to copy. Enhance draft first.", "warning");
  });

  it("notifies when trying to apply without enhancement", () => {
    const notifyFn = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "",
      notifyFn,
    }));
    bindModal(modal);

    press(modal, "\u001ba"); // Alt+a (apply)
    expect(notifyFn).toHaveBeenCalledWith("No enhanced result to apply. Enhance draft first.", "warning");
  });

  it("notifies when trying to send without enhancement", () => {
    const notifyFn = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "",
      notifyFn,
    }));
    bindModal(modal);

    press(modal, "\u001bs"); // Alt+s (send)
    expect(notifyFn).toHaveBeenCalledWith("No enhanced result to send. Enhance draft first.", "warning");
  });

  it("notifies when trying to copy with draft text but no enhancement", () => {
    const notifyFn = vi.fn();
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "some draft text",
      notifyFn,
    }));
    bindModal(modal);

    // Even though there's draft text, copy requires an enhanced result
    press(modal, "\u001by"); // Alt+y (copy)
    expect(notifyFn).toHaveBeenCalledWith("No enhanced result to copy. Enhance draft first.", "warning");
  });
});

describe("PromptGenModal invalidate/cache", () => {
  it("invalidate clears the cache", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "test" }));
    bindModal(modal);

    const lines1 = modal.render(80);
    // Second render without change should return cached lines (same reference?)
    // Actually the implementation creates a new array each render if cache was invalidated
    modal.invalidate();
    const lines2 = modal.render(80);
    expect(lines2.length).toBe(lines1.length);
  });
});

// ---------------------------------------------------------------------------
// Regression tests
// ---------------------------------------------------------------------------

describe("Border frame consistency", () => {
  it("every rendered line has visibleWidth equal to the render width", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "hello" }));
    bindModal(modal);

    const width = 80;
    const lines = modal.render(width);
    for (let i = 0; i < lines.length; i++) {
      expect(visibleWidth(lines[i]!)).toBe(width);
    }
  });

  it("frame lines at different render widths all have consistent visibleWidth", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "a" }));
    bindModal(modal);

    for (const width of [40, 60, 80, 100]) {
      const lines = modal.render(width);
      for (let i = 0; i < lines.length; i++) {
        expect(visibleWidth(lines[i]!)).toBe(width);
      }
    }
  });

  it("border glyphs (│, ╭, ╰, ╯, ─) are styled with fg('border', ...)", () => {
    const theme = makeTrackingTheme();
    const modal = new PromptGenModal(makeModalOptions({ initialText: "test" }));
    modal.bind(theme, vi.fn(), vi.fn());

    modal.render(80);

    // All border glyphs must have been passed through fg("border", ...)
    // The tracking theme records all fg() calls.  Collect the texts that
    // were styled with "border" and verify they contain the frame chars.
    const borderStyledTexts = theme.calls
      .filter((c) => c.color === "border")
      .map((c) => c.text)
      .join("");

    expect(borderStyledTexts).toContain("╭");
    expect(borderStyledTexts).toContain("╮");
    expect(borderStyledTexts).toContain("╰");
    expect(borderStyledTexts).toContain("╯");
    expect(borderStyledTexts).toContain("─");
    // Side borders: every content line is wrapped with │ ... │
    // At least one │ should appear in border calls
    expect(borderStyledTexts).toContain("│");
  });

  it("title is styled with fg('accent', ...) and not mixed with border", () => {
    const theme = makeTrackingTheme();
    const modal = new PromptGenModal(makeModalOptions({ initialText: "test" }));
    modal.bind(theme, vi.fn(), vi.fn());

    modal.render(80);

    // The title "/prompt" should appear in an accent call
    const accentStyled = theme.calls.filter((c) => c.color === "accent");
    const allAccentTexts = accentStyled.map((c) => c.text).join("");
    expect(allAccentTexts).toContain("/prompt");

    // Title text should NOT appear in border calls
    const borderStyled = theme.calls.filter((c) => c.color === "border");
    const allBorderTexts = borderStyled.map((c) => c.text).join("");
    expect(allBorderTexts).not.toContain("/prompt");
  });
});

describe("Draft soft-wrapping", () => {
  it("long single-line draft wraps across multiple visual lines instead of truncating", () => {
    const longLine = "A".repeat(200);
    const modal = new PromptGenModal(makeModalOptions({ initialText: longLine }));
    bindModal(modal);

    // Render at a width narrow enough to force wrapping
    const width = 30;
    const lines = modal.render(width);

    // The draft text is soft-wrapped across multiple visual lines.
    const draftLineTexts = lines.filter((l) => /A{5}/.test(l));
    expect(draftLineTexts.length).toBeGreaterThan(1);

    // Count only A characters from the wrapped draft rows, not from help text.
    const totalA = draftLineTexts.reduce((sum, l) => sum + (l.match(/A/g)?.length ?? 0), 0);
    expect(totalA).toBeGreaterThanOrEqual(178);
    expect(totalA).toBeLessThanOrEqual(200);
  });

  it("shows the cursor on the next visual line when the draft ends exactly at wrap width", () => {
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "A".repeat(26),
    }));
    bindModal(modal);

    const lines = modal.render(30); // inner width = 26
    const joined = lines.join("\n");
    expect(joined).toContain("A".repeat(26));
    expect(joined).toContain("▌");
  });

  it("shows the cursor at a full-width hard-line boundary before a following hard line", () => {
    const bgCalls: Array<{ color: string; text: string }> = [];
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (color: string, text: string) => {
        bgCalls.push({ color, text });
        return text;
      },
      bold: (text: string) => text,
      dim: (text: string) => text,
      italic: (text: string) => text,
      underline: (text: string) => text,
    } as unknown as Theme;

    const modal = new PromptGenModal(makeModalOptions({
      initialText: `${"A".repeat(26)}\nB`,
    }));
    modal.bind(theme, vi.fn(), vi.fn());

    modal.render(30);

    // Cursor starts at end of draft. Home moves to start of second hard line,
    // left moves back to the boundary before the newline.
    press(modal, "\u001b[H");
    press(modal, "\u001b[D");

    const lines = modal.render(30);
    const joined = lines.join("\n");
    expect(joined).toContain("A".repeat(26));
    expect(joined).toContain("B");
    expect(bgCalls).toContainEqual({ color: "selectedBg", text: "B" });
  });

  it("cursor navigates up/down across wrapped lines", () => {
    const longLine = "A".repeat(120);
    const modal = new PromptGenModal(makeModalOptions({ initialText: longLine }));
    bindModal(modal);

    // Render once at narrow width to set up wrapping state
    modal.render(30);

    // Cursor starts at end of the long line
    // Moving up should move to the visual line above
    press(modal, "\u001b[A"); // up arrow

    // After moving up and inserting, text should appear at correct position
    press(modal, "\u001b[H"); // home → start of hard line
    type(modal, "X");

    const lines = modal.render(30);
    const joined = lines.join("");
    // The "X" should be at the start of the first wrapped segment
    expect(joined).toContain("X");
  });

  it("backspace at wrap boundary removes last char of previous wrapped segment", () => {
    const longLine = "A".repeat(60);
    const modal = new PromptGenModal(makeModalOptions({ initialText: longLine }));
    bindModal(modal);

    modal.render(30);

    // Home → cursor at start of line
    press(modal, "\u001b[H");

    // Move right by the width of one wrapped segment (inner = 26)
    for (let i = 0; i < 26; i++) {
      press(modal, "\u001b[C");
    }

    // Cursor is at the start of the second wrapped segment (position 26)
    // Backspace removes the last char of the previous segment
    press(modal, "\x7f");

    // The total length should be 59 instead of 60
    // The exact content check: first wrapped segment should have 25 A's now
    // (was 26, one removed by backspace)
    const lines = modal.render(30);
    const joined = lines.join("");
    // Still has A's but one less
    expect(joined).toContain("A".repeat(25));
  });

  it("Enter still triggers enhancement regardless of wrapping", async () => {
    const enhanceFn = vi.fn().mockResolvedValue(makeEnhanceResult());
    const modal = new PromptGenModal(makeModalOptions({
      initialText: "A".repeat(150),
      enhanceFn,
    }));
    bindModal(modal);

    modal.render(30);

    press(modal, "\r");

    await vi.waitFor(() => {
      expect(enhanceFn).toHaveBeenCalledTimes(1);
    });
  });

  it("backspace merges hard lines correctly after wrapping", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "hello" }));
    bindModal(modal);

    modal.render(30);

    // Insert newline then backspace should merge back
    press(modal, "\u001b[13;2u"); // Shift+Enter

    type(modal, "world");

    // Backspace at start of second line (between 'hello' and 'world')
    // Need to move cursor to start of "world"
    // Cursor is at position 11 (after "hello\nworld" = 5+1+5 = 11)
    // Move left 5 times to get to position 6 (the newline)
    for (let i = 0; i < 5; i++) {
      press(modal, "\u001b[D");
    }

    press(modal, "\x7f"); // backspace removes the newline

    const lines = modal.render(30);
    const joined = lines.join("");
    // After backspace removes the newline, the draft reads "helloworld"
    // but rendered output interleaves the cursor marker (▌) at the merge
    // point, so we check that "hello" and "world" appear without a newline
    // between them (excluding the cursor artifact).
    expect(joined).toContain("hello");
    expect(joined).toContain("world");
    // Verify there's no newline separating hello and world in the output
    // (the cursor marker ▌ may appear between them)
    expect(joined).not.toContain("hello\n");
  });

  it("Home navigates to start of hard line after wrapping", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "A".repeat(80) }));
    bindModal(modal);

    modal.render(30);

    // Home → should go to position 0 (start of hard line)
    press(modal, "\u001b[H"); // home

    type(modal, "X");

    const lines = modal.render(30);
    const joined = lines.join("");
    expect(joined).toContain("X");
    // X should be at the start of the first A chunk
    expect(joined.indexOf("X")).toBeLessThan(joined.indexOf("A"));
  });

  it("End navigates to end of hard line after wrapping", () => {
    const modal = new PromptGenModal(makeModalOptions({ initialText: "A".repeat(80) }));
    bindModal(modal);

    modal.render(30);

    // Home then End → cursor at end of hard line
    press(modal, "\u001b[H"); // home
    press(modal, "\u001b[F"); // end

    type(modal, "X");

    const lines = modal.render(30);
    const joined = lines.join("");
    // The draft should end with "X" (appended at end of hard line)
    expect(joined).toContain("X");
  });
});
