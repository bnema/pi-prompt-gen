/**
 * PromptGenModal — overlay component for pi-prompt-gen.
 *
 * Provides a full-screen modal with:
 *  - Labeled Draft and Result panes
 *  - Rewrite/generate mode toggle with mode-specific microcopy
 *  - Enhancement via enhancePrompt() (injected as dependency)
 *  - Result preview pane with truncation warning
 *  - Actions: apply to editor, copy to clipboard, send as user message
 *  - Status feedback (idle, enhancing, enhanced, error)
 *  - Result metadata (ref count, line count)
 *  - Prefill source indicator (args/editor/session/blank)
 *  - Closes on successful send
 *
 * Keybindings:
 *   Enter        enhance / re-enhance
 *   Alt+r        regenerate / alternative (materially different output)
 *   Alt+m        toggle rewrite / generate mode
 *   Alt+c        clear draft
 *   Alt+y        yank (copy) enhanced result to clipboard
 *   Alt+a        apply enhanced result to Pi editor
 *   Alt+s        send enhanced result as user message
 *   Escape       close modal (or abort running enhancement)
 *
 * Design notes:
 *  - Uses a simple string buffer for the draft (not Pi's Editor component)
 *    so that bare Enter always triggers enhancement without fighting the
 *    Editor's built-in submit / newline logic.
 *  - Shift+Enter inserts a newline in the draft.
 *  - Every enhancement call is a fresh isolated request — no caching.
 *  - Actions (copy/apply/send) require an enhanced result — no silent
 *    fallback to the raw draft.
 */

import type { Component as TuiComponent } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { EnhancePromptResult } from "./index.js";
import type { EnhancerMode } from "./enhancer-prompt.js";

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/** A soft-wrapped segment of the draft text. */
interface WrappedLine {
  /** The segment text (at most `width` cells wide). */
  text: string;
  /** Which hard (newline-separated) line this segment belongs to. */
  hardLine: number;
  /** Absolute start offset of this segment in the draft string. */
  start: number;
  /** Absolute end offset (exclusive) of this segment in the draft string. */
  end: number;
  /** Whether this segment exactly filled the wrap width. */
  fullWidth: boolean;
}

/**
 * Soft-wrap each hard line of `text` to fit `width` visible cells.
 * Empty hard lines produce a single empty segment so visual line count
 * stays in sync with the newline-delimited source.
 */
function wrapToWidth(text: string, width: number): WrappedLine[] {
  if (width <= 0) width = 1;
  const hardLines = text.split("\n");
  const result: WrappedLine[] = [];
  let hardOffset = 0;

  for (let hl = 0; hl < hardLines.length; hl++) {
    const line = hardLines[hl]!;
    if (line.length === 0) {
      result.push({ text: "", hardLine: hl, start: hardOffset, end: hardOffset, fullWidth: false });
    } else {
      let segment = "";
      let segmentWidth = 0;
      let segmentStart = 0;
      let i = 0;

      while (i < line.length) {
        const codePoint = line.codePointAt(i)!;
        const ch = String.fromCodePoint(codePoint);
        const step = ch.length;
        const chWidth = visibleWidth(ch);

        if (segment !== "" && segmentWidth + chWidth > width) {
          result.push({
            text: segment,
            hardLine: hl,
            start: hardOffset + segmentStart,
            end: hardOffset + i,
            fullWidth: segmentWidth >= width,
          });
          segment = "";
          segmentWidth = 0;
          segmentStart = i;
          continue;
        }

        segment += ch;
        segmentWidth += chWidth;
        i += step;
      }

      result.push({
        text: segment,
        hardLine: hl,
        start: hardOffset + segmentStart,
        end: hardOffset + line.length,
        fullWidth: segmentWidth >= width,
      });
    }

    hardOffset += line.length;
    if (hl < hardLines.length - 1) hardOffset += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModalStatus = "idle" | "enhancing" | "enhanced" | "error";

export interface PromptGenModalOptions {
  /** Initial draft text (prefilled from args / editor / session / blank). */
  initialText?: string;
  /** Optional label describing where initialText came from ("args", "editor", "session", "blank"). */
  initialTextLabel?: string;
  /** Initial mode. Auto-detected from initialText when not provided. */
  mode?: EnhancerMode;
  /** Callback that performs the actual enhancement. */
  enhanceFn: (text: string, mode: EnhancerMode, signal?: AbortSignal, previousOutput?: string, onProgress?: (message: string) => void) => Promise<EnhancePromptResult>;
  /** Copy text to clipboard. */
  copyFn: (text: string) => Promise<void>;
  /** Write text to the main Pi editor. */
  applyFn: (text: string) => void;
  /** Send text as a user message. */
  sendFn: (text: string) => Promise<void> | void;
  /** Notify the user. */
  notifyFn: (message: string, type?: "info" | "warning" | "error") => void;
  /**
   * Called when enhancement completes. Receives the raw model output so the
   * caller can inspect refs, usage, etc. for telemetry / testing.
   */
  onEnhanceResult?: (result: EnhancePromptResult) => void;
}

/** Result delivered when the modal closes (via done). */
export interface PromptGenModalResult {
  /** The final draft text at close time. */
  draftText: string;
  /** The last enhanced result (undefined if never enhanced). */
  lastResult: EnhancePromptResult | undefined;
}

// ---------------------------------------------------------------------------
// Theme helper
// ---------------------------------------------------------------------------

/** Shorthand for a single rendered line that respects truncation. */
type RenderLine = string;

/**
 * Shorthand to theme a string with the border color.
 * Used inside frameContent to keep border styling consistent.
 */
function borderStyled(s: string, theme: Theme): string {
  return theme.fg("border", s);
}

/** Create a box-drawing frame around content lines. */
function frameContent(lines: RenderLine[], width: number, title: string, theme: Theme): string[] {
  const inner = Math.max(10, width - 4);
  const b = (s: string) => borderStyled(s, theme);

  // Top border: ╭─ <title> ───╮
  // Total visual width must equal inner + 4 to match content / bottom lines.
  // Prefix ╭─  = 3 cells, space after title = 1 cell, suffix ╮ = 1 cell → 5 overhead.
  // Remaining cells: (inner + 4) - 5 - visibleWidth(title) = inner - 1 - visibleWidth(title)
  const fillLen = Math.max(0, inner - 1 - visibleWidth(title));
  const top = `${b("╭─")} ${theme.fg("accent", title)} ${b("─".repeat(fillLen) + "╮")}`;

  // Bottom border: ╰───╯
  const bottom = `${b("╰")}${b("─".repeat(inner + 2))}${b("╯")}`;

  const out = [top];
  for (const line of lines) {
    const truncated = truncateToWidth(line, inner);
    const padded = truncated + " ".repeat(Math.max(0, inner - visibleWidth(truncated)));
    out.push(`${b("│")} ${padded} ${b("│")}`);
  }
  out.push(bottom);
  return out;
}

/** A labeled pane separator like "── Draft ────────────". */
function paneSeparator(label: string, width: number, theme: Theme): string {
  const labelDisplay = `── ${label} `;
  const prefixWidth = visibleWidth(labelDisplay);
  const fill = Math.max(0, width - prefixWidth);
  return dim(labelDisplay + "─".repeat(fill), theme);
}

function dim(text: string, theme: Theme): string {
  return theme.fg("muted", text);
}

function accent(text: string, theme: Theme): string {
  return theme.fg("accent", text);
}

function warning(text: string, theme: Theme): string {
  return theme.fg("warning", text);
}

function success(text: string, theme: Theme): string {
  return theme.fg("success", text);
}

function cursorCell(text: string, theme: Theme): string {
  if (text === " ") return accent("▌", theme);
  return theme.bg("selectedBg", theme.fg("text", text));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DRAFT_HEIGHT = 8;
const MAX_PREVIEW_HEIGHT = 10;
const ENHANCING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ENHANCING_SPINNER_INTERVAL_MS = 120;
// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class PromptGenModal implements TuiComponent {
  // ---- state ----
  private draft = "";
  private cursor = 0; // linear 0-based index into draft
  private mode: EnhancerMode;
  private status: ModalStatus = "idle";
  private statusMessage = "";
  private result: EnhancePromptResult | undefined;
  private draftScroll = 0; // first visible visual (wrapped) line
  private draftWrapWidth = 0; // latest wrap width from render()
  private requestVersion = 0;
  private activeAbort: AbortController | undefined;
  private spinnerFrameIndex = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private progressMessage = "";
  private progressLog: string[] = [];

  // ---- injected ----
  private theme!: Theme;
  private done!: (result: PromptGenModalResult | undefined) => void;
  private requestRender!: () => void;
  private keybindings: { matches(data: string, keybinding: string): boolean } | undefined;
  private enhanceFn: (text: string, mode: EnhancerMode, signal?: AbortSignal, previousOutput?: string, onProgress?: (message: string) => void) => Promise<EnhancePromptResult>;
  private copyFn: (text: string) => Promise<void>;
  private applyFn: (text: string) => void;
  private sendFn: (text: string) => Promise<void> | void;
  private notifyFn: (message: string, type?: "info" | "warning" | "error") => void;
  private onEnhanceResult: ((result: EnhancePromptResult) => void) | undefined;
  private initialTextLabel: string | undefined;

  constructor(options: PromptGenModalOptions) {
    this.draft = options.initialText ?? "";
    this.mode = options.mode ?? (this.draft.trim() ? "rewrite" : "generate");
    this.enhanceFn = options.enhanceFn;
    this.copyFn = options.copyFn;
    this.applyFn = options.applyFn;
    this.sendFn = options.sendFn;
    this.notifyFn = options.notifyFn;
    this.onEnhanceResult = options.onEnhanceResult;
    this.initialTextLabel = options.initialTextLabel;
    this.cursor = this.draft.length;
  }

  /**
   * Called by the `custom()` factory to wire the render cycle.
   * Must be called before any render / handleInput.
   */
  bind(
    theme: Theme,
    done: (result: PromptGenModalResult | undefined) => void,
    requestRender: () => void,
    keybindings?: { matches(data: string, keybinding: string): boolean },
  ): void {
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
    this.keybindings = keybindings;
  }

  // ---------------------------------------------------------------
  // Component interface
  // ---------------------------------------------------------------

  invalidate(): void {
    // This component renders from live state on every request.
  }

  render(width: number): string[] {
    const inner = Math.max(20, width - 4);

    const lines: string[] = [];

    // Mode indicator + status line (with prefill source and mode hint)
    const modeLabel = this.mode === "rewrite" ? "rewrite" : "generate";
    const modeHint = this.mode === "rewrite"
      ? "refine a prompt"
      : "idea \u2192 prompt";
    const prefillInfo = this.initialTextLabel && this.initialTextLabel !== "blank"
      ? dim(` (${this.initialTextLabel})`, this.theme)
      : "";
    const modeDisplay = this.status === "enhancing"
      ? accent(`[${modeLabel}]`, this.theme) + " " + accent(this.currentSpinnerFrame(), this.theme) + " " + dim(this.progressMessage || "enhancing\u2026", this.theme) + prefillInfo
      : accent(`[${modeLabel}]`, this.theme) + " " + dim(this.statusDisplay(), this.theme) + prefillInfo;
    lines.push(modeDisplay + "  " + dim(modeHint, this.theme) + " ".repeat(Math.max(0, inner - visibleWidth(modeDisplay) - 2 - visibleWidth(modeHint))));

    // Draft pane
    lines.push(paneSeparator("Draft", inner, this.theme));

    // Draft editor area — soft-wrapped to inner width
    this.draftWrapWidth = inner;
    this.ensureCursorVisible();
    const wrapped = wrapToWidth(this.draft, inner);
    const draftHeight = Math.min(MAX_DRAFT_HEIGHT, Math.max(3, wrapped.length + 1));

    for (let i = 0; i < draftHeight; i++) {
      const vi = this.draftScroll + i;
      if (vi < wrapped.length) {
        const text = wrapped[vi]!.text;
        // text is already at most inner cells wide from wrapToWidth — don't truncate
        // Render cursor on the correct visual line
        const cursorLine = this.cursorToPosition().line;
        const cursorCol = this.cursorToPosition().col;
        if (vi === cursorLine && this.status !== "enhancing") {
          const before = text.slice(0, cursorCol);
          const atCursor = text[cursorCol] ?? " ";
          const after = text.slice(cursorCol + (text[cursorCol] ? 1 : 0));
          lines.push(`${before}${cursorCell(atCursor, this.theme)}${after}`);
        } else {
          lines.push(text + " ".repeat(Math.max(0, inner - visibleWidth(text))));
        }
      } else if (vi === wrapped.length) {
        // Empty last line with cursor at end
        if (this.status !== "enhancing" && vi === this.cursorToPosition().line) {
          const col = this.cursorToPosition().col;
          lines.push(" ".repeat(col) + accent("▌", this.theme) + " ".repeat(Math.max(0, inner - col - 1)));
        } else {
          lines.push(dim("~", this.theme) + " ".repeat(inner - 1));
        }
      } else {
        lines.push(dim("~", this.theme) + " ".repeat(inner - 1));
      }
    }

    // Result pane
    lines.push(paneSeparator("Result", inner, this.theme));

    // Result / preview area
    if (this.result) {
      const previewLines = this.result.enhancedPrompt.split("\n");
      const displayLines = previewLines.slice(0, MAX_PREVIEW_HEIGHT);
      for (const pl of displayLines) {
        lines.push(truncateToWidth(pl, inner) + " ".repeat(Math.max(0, inner - visibleWidth(pl))));
      }
      if (previewLines.length > MAX_PREVIEW_HEIGHT) {
        const remaining = previewLines.length - MAX_PREVIEW_HEIGHT;
        const truncatedMsg = dim(`  (${remaining} more line${remaining > 1 ? "s" : ""} — actions use full result)`, this.theme);
        lines.push(truncatedMsg + " ".repeat(Math.max(0, inner - visibleWidth(truncatedMsg))));
      } else if (displayLines.length < MAX_PREVIEW_HEIGHT) {
        for (let i = displayLines.length; i < MAX_PREVIEW_HEIGHT; i++) {
          lines.push("");
        }
      }
    } else {
      const progressLines = this.status === "enhancing"
        ? this.progressLog.slice(-MAX_PREVIEW_HEIGHT)
        : [];
      if (progressLines.length > 0) {
        for (const progressLine of progressLines) {
          lines.push(truncateToWidth(progressLine, inner) + " ".repeat(Math.max(0, inner - visibleWidth(progressLine))));
        }
        for (let i = progressLines.length; i < MAX_PREVIEW_HEIGHT; i++) lines.push("");
      } else {
        const placeholder = this.status === "idle"
          ? dim("Press Enter to enhance, or type your prompt.", this.theme)
          : "";
        lines.push(placeholder);
        for (let i = 1; i < MAX_PREVIEW_HEIGHT; i++) lines.push("");
      }
    }

    // Metadata line
    if (this.result) {
      const parts: string[] = [];
      const refCount = this.result.refs.length;
      const lineCount = this.result.enhancedPrompt.split("\n").length;
      if (refCount > 0) {
        parts.push(`\u25cf ${refCount} ref${refCount > 1 ? "s" : ""}`);
      }
      parts.push(`${lineCount} line${lineCount > 1 ? "s" : ""}`);
      const meta = dim(parts.join(" \u00b7 "), this.theme);
      lines.push(meta + " ".repeat(Math.max(0, inner - visibleWidth(meta))));
    } else {
      lines.push("");
    }

    // Help lines (state-aware)
    const hasResult = this.status === "enhanced" && this.result !== undefined;
    if (hasResult) {
      lines.push(dim(
        `[Enter] Re-enhance  [Alt+R] Alternative  [Alt+M] Mode  [Alt+C] Clear`,
        this.theme,
      ));
      lines.push(dim(
        `[Alt+Y] Copy  [Alt+A] Apply  [Alt+S] Send  [Esc] Close`,
        this.theme,
      ));
    } else {
      lines.push(dim(
        `[Enter] Enhance  [Alt+M] Mode  [Alt+C] Clear  [Esc] Close`,
        this.theme,
      ));
      lines.push(dim(
        `[Alt+R] Regenerate  [Alt+Y] Copy  [Alt+A] Apply  [Alt+S] Send`,
        this.theme,
      ));
    }

    return frameContent(lines, width, "/prompt", this.theme);
  }

  // ---------------------------------------------------------------
  // Input handling
  // ---------------------------------------------------------------

  handleInput(data: string): void {
    // Always handle cancel/escape via injected keybindings when available.
    if (this.matchesAction(data, "tui.select.cancel", Key.escape)) {
      if (this.status === "enhancing") {
        this.requestVersion += 1;
        this.activeAbort?.abort();
        this.activeAbort = undefined;
        this.setStatus("idle", "cancelled");
        this.requestRender();
        return;
      }
      this.done({ draftText: this.draft, lastResult: this.result });
      return;
    }

    // Block other input during enhancement
    if (this.status === "enhancing") return;

    // Alt shortcuts (must be checked before printable characters)
    // Alt+r regenerates / requests an alternative
    if (this.matchesAction(data, "alt+r", Key.alt("r"))) {
      void this.runEnhancement(true);
      return;
    }
    if (this.matchesAction(data, "alt+m", Key.alt("m"))) {
      this.toggleMode();
      this.requestRender();
      return;
    }
    if (this.matchesAction(data, "alt+c", Key.alt("c")) || this.matchesAction(data, "app.clear", "ctrl+c")) {
      this.clearDraft();
      this.requestRender();
      return;
    }
    if (this.matchesAction(data, "alt+y", Key.alt("y"))) {
      void this.copyResult();
      return;
    }
    if (this.matchesAction(data, "alt+a", Key.alt("a"))) {
      this.applyResult();
      return;
    }
    if (this.matchesAction(data, "alt+s", Key.alt("s"))) {
      void this.sendResult();
      return;
    }

    // Enter (bare) → enhance
    if (this.matchesAction(data, "tui.input.submit", Key.enter) || matchesKey(data, Key.return)) {
      void this.runEnhancement();
      return;
    }

    // Shift+Enter (or remapped newline binding) → newline
    if (this.matchesAction(data, "tui.input.newLine", Key.shift("enter")) || matchesKey(data, Key.shift("return"))) {
      this.insertAtCursor("\n");
      this.requestRender();
      return;
    }

    // Ctrl+U → clear line / full clear
    if (matchesKey(data, "ctrl+u")) {
      this.clearDraft();
      this.requestRender();
      return;
    }

    // Cursor navigation
    if (matchesKey(data, Key.up)) {
      this.moveCursorLine(-1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveCursorLine(1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.ensureCursorVisible();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.cursor = Math.min(this.draft.length, this.cursor + 1);
      this.ensureCursorVisible();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.home)) {
      const pos = this.cursorToPosition();
      const wrapped = this.getWrappedLines();
      const wl = wrapped[pos.line];
      if (wl) {
        this.cursor = this.hardLineStartOffset(wl.hardLine);
      } else {
        this.cursor = 0;
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      const pos = this.cursorToPosition();
      const wrapped = this.getWrappedLines();
      const wl = wrapped[pos.line];
      if (wl) {
        const hl = wl.hardLine;
        this.cursor = this.hardLineStartOffset(hl) + this.hardLineLength(hl);
      } else {
        this.cursor = this.draft.length;
      }
      this.requestRender();
      return;
    }

    // Backspace
    if (matchesKey(data, Key.backspace)) {
      if (this.cursor > 0) {
        this.draft = this.draft.slice(0, this.cursor - 1) + this.draft.slice(this.cursor);
        this.cursor -= 1;
        this.invalidateEnhancedResult("draft changed");
      }
      this.ensureCursorVisible();
      this.requestRender();
      return;
    }

    // Delete
    if (matchesKey(data, Key.delete)) {
      if (this.cursor < this.draft.length) {
        this.draft = this.draft.slice(0, this.cursor) + this.draft.slice(this.cursor + 1);
        this.invalidateEnhancedResult("draft changed");
      }
      this.requestRender();
      return;
    }

    // Printable character insertion
    if (this.isPrintable(data)) {
      this.insertAtCursor(data);
      this.requestRender();
      return;
    }
  }

  // ---------------------------------------------------------------
  // Text editing helpers
  // ---------------------------------------------------------------

  private isPrintable(data: string): boolean {
    return data.length === 1 && data >= " " && data !== "\x7f";
  }

  private insertAtCursor(text: string): void {
    this.draft = this.draft.slice(0, this.cursor) + text + this.draft.slice(this.cursor);
    this.cursor += text.length;
    this.invalidateEnhancedResult("draft changed");
    // If text was blank and we just inserted the first character, switch mode if blank
    if (this.mode === "generate" && this.draft.trim().length > 0) {
      // Auto switch to rewrite when user types content in generate mode?
      // No, keep the mode as-is; user can toggle with Alt+m
    }
    this.ensureCursorVisible();
  }

  /**
   * Return wrapped lines using the latest render width.
   * Falls back to a reasonable default if never rendered.
   */
  private getWrappedLines(): WrappedLine[] {
    return wrapToWidth(this.draft, this.draftWrapWidth || Math.max(20, 80 - 4));
  }

  /** Linear position of the start (first character) of a hard line. */
  private hardLineStartOffset(hardLine: number): number {
    const hardLines = this.draft.split("\n");
    let offset = 0;
    for (let i = 0; i < hardLine && i < hardLines.length; i++) {
      offset += hardLines[i]!.length + 1; // +1 for the newline
    }
    return offset;
  }

  /** Length (in characters) of a hard (newline-separated) line. */
  private hardLineLength(hardLine: number): number {
    const hardLines = this.draft.split("\n");
    if (hardLine < 0 || hardLine >= hardLines.length) return 0;
    return hardLines[hardLine]!.length;
  }

  /**
   * Convert linear cursor position to {visualLine, col} where
   * visualLine is the index into the soft-wrapped line array.
   */
  private cursorToPosition(): { line: number; col: number } {
    const wrapped = this.getWrappedLines();
    if (wrapped.length === 0) return { line: 0, col: 0 };

    for (let i = 0; i < wrapped.length; i++) {
      const wl = wrapped[i]!;
      if (this.cursor < wl.end) {
        return { line: i, col: this.cursor - wl.start };
      }
      if (this.cursor === wl.end) {
        const next = wrapped[i + 1];
        if (next && next.hardLine === wl.hardLine && next.start === wl.end) {
          return { line: i + 1, col: 0 };
        }
        if (next && next.hardLine !== wl.hardLine && wl.fullWidth) {
          return { line: i + 1, col: 0 };
        }
        if (i === wrapped.length - 1 && this.cursor === this.draft.length && wl.fullWidth) {
          return { line: wrapped.length, col: 0 };
        }
        return { line: i, col: wl.text.length };
      }
    }

    const last = wrapped[wrapped.length - 1]!;
    if (last.fullWidth) {
      return { line: wrapped.length, col: 0 };
    }
    return { line: wrapped.length - 1, col: last.text.length };
  }

  /**
   * Convert visual {line, col} to linear cursor position.
   * line is a soft-wrapped visual line index, col is column within it.
   */
  private positionToCursor(line: number, col: number): number {
    const wrapped = this.getWrappedLines();
    if (wrapped.length === 0) return 0;
    if (line <= 0) line = 0;
    if (line >= wrapped.length) return this.draft.length;
    const seg = wrapped[line]!;
    col = Math.max(0, Math.min(seg.text.length, col));
    return seg.start + col;
  }

  /** Move cursor up/down by `delta` visual (wrapped) lines. */
  private moveCursorLine(delta: number): void {
    const pos = this.cursorToPosition();
    const wrapped = this.getWrappedLines();
    const extraLine = wrapped.length > 0 && wrapped[wrapped.length - 1]!.fullWidth ? 1 : 0;
    const maxLine = Math.max(0, wrapped.length - 1 + extraLine);
    const newLine = Math.max(0, Math.min(maxLine, pos.line + delta));
    if (newLine !== pos.line) {
      this.cursor = this.positionToCursor(newLine, pos.col);
      this.ensureCursorVisible();
    }
  }

  /** Ensure the cursor visual line is visible within the draft viewport. */
  private ensureCursorVisible(): void {
    const pos = this.cursorToPosition();
    const wrapped = this.getWrappedLines();
    const extraLine = wrapped.length > 0 && wrapped[wrapped.length - 1]!.fullWidth ? 1 : 0;
    const draftHeight = Math.min(MAX_DRAFT_HEIGHT, Math.max(3, wrapped.length + extraLine));
    if (pos.line < this.draftScroll) {
      this.draftScroll = pos.line;
    } else if (pos.line >= this.draftScroll + draftHeight) {
      this.draftScroll = pos.line - draftHeight + 1;
    }
  }

  // ---------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------

  private toggleMode(): void {
    this.mode = this.mode === "rewrite" ? "generate" : "rewrite";
    this.result = undefined;
    this.progressMessage = "";
    this.progressLog = [];
    this.setStatus("idle", `switched to ${this.mode}`);
  }

  private clearDraft(): void {
    this.draft = "";
    this.cursor = 0;
    this.draftScroll = 0;
    this.result = undefined;
    this.progressMessage = "";
    this.progressLog = [];
    this.setStatus("idle", "draft cleared");
    // Switch to generate mode when draft is cleared
    if (this.mode === "rewrite") {
      this.mode = "generate";
    }
  }

  private async runEnhancement(regenerate = false): Promise<void> {
    const text = this.draft.trim();
    if (!text) {
      this.notifyFn("Nothing to enhance — type something first.", "warning");
      return;
    }

    const requestId = ++this.requestVersion;
    const controller = new AbortController();
    const previousOutput = regenerate ? this.result?.enhancedPrompt : undefined;
    this.activeAbort = controller;
    this.progressMessage = "Examining codebase…";
    this.progressLog = ["Examining codebase…"];
    this.setStatus("enhancing", "enhancing…");
    this.result = undefined;
    this.requestRender();

    try {
      const result = await this.enhanceFn(
        text,
        this.mode,
        controller.signal,
        previousOutput,
        (message: string) => {
          if (!message || requestId !== this.requestVersion || controller.signal.aborted) return;
          this.progressMessage = message;
          if (this.progressLog[this.progressLog.length - 1] !== message) {
            this.progressLog.push(message);
            if (this.progressLog.length > MAX_PREVIEW_HEIGHT) this.progressLog.shift();
          }
          this.requestRender();
        },
      );
      if (controller.signal.aborted || requestId !== this.requestVersion) return;
      this.result = result;
      this.setStatus("enhanced", "");
      this.onEnhanceResult?.(result);
    } catch (err) {
      if (controller.signal.aborted || requestId !== this.requestVersion) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
    } finally {
      if (this.activeAbort === controller) this.activeAbort = undefined;
    }
    this.requestRender();
  }

  private async copyResult(): Promise<void> {
    const text = this.result?.enhancedPrompt;
    if (!text) {
      this.notifyFn("No enhanced result to copy. Enhance draft first.", "warning");
      return;
    }
    try {
      await this.copyFn(text);
      this.notifyFn("Copied to clipboard.", "info");
    } catch {
      this.notifyFn("Failed to copy to clipboard.", "error");
    }
  }

  private applyResult(): void {
    const text = this.result?.enhancedPrompt;
    if (!text) {
      this.notifyFn("No enhanced result to apply. Enhance draft first.", "warning");
      return;
    }
    this.applyFn(text);
    this.notifyFn("Applied to editor.", "info");
  }

  private async sendResult(): Promise<void> {
    const text = this.result?.enhancedPrompt;
    if (!text) {
      this.notifyFn("No enhanced result to send. Enhance draft first.", "warning");
      return;
    }
    try {
      await this.sendFn(text);
      // Close modal on successful send
      this.done({ draftText: this.draft, lastResult: this.result });
    } catch {
      this.notifyFn("Failed to send prompt.", "error");
    }
  }

  // ---------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------

  private setStatus(status: ModalStatus, message: string): void {
    this.status = status;
    this.statusMessage = message;

    if (status === "enhancing") {
      this.startSpinner();
      return;
    }

    this.stopSpinner();
  }

  private invalidateEnhancedResult(message: string): void {
    if (!this.result && this.status !== "enhanced") return;
    this.result = undefined;
    this.progressMessage = "";
    this.progressLog = [];
    this.setStatus("idle", message);
  }

  private statusDisplay(): string {
    switch (this.status) {
      case "idle":
        return this.statusMessage || "ready";
      case "enhancing":
        return "enhancing…";
      case "enhanced":
        return success("enhanced", this.theme);
      case "error":
        return warning(`error: ${truncateToWidth(this.statusMessage, 40)}`, this.theme);
    }
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerFrameIndex = 0;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % ENHANCING_SPINNER_FRAMES.length;
      this.requestRender();
    }, ENHANCING_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.spinnerFrameIndex = 0;
  }

  private currentSpinnerFrame(): string {
    return ENHANCING_SPINNER_FRAMES[this.spinnerFrameIndex] ?? ENHANCING_SPINNER_FRAMES[0]!;
  }

  private matchesAction(data: string, binding: string, fallback: string): boolean {
    return Boolean(this.keybindings?.matches(data, binding)) || matchesKey(data, fallback as never);
  }
}
