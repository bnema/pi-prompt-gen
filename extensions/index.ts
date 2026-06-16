/**
 * pi-prompt-gen extension entry point.
 *
 * Registers the /prompt command for modal or inline prompt enhancement.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { browseCodebase, SAFE_BROWSE_TOOL_NAMES, type BrowseSessionHistoryMessage } from "../src/browse-pass.js";
import { enhancePrompt } from "../src/index.js";
import { buildMetadataSummaryParts } from "../src/debug-artifact.js";
import { PromptGenModal } from "../src/modal.js";
import type { EnhancerMode } from "../src/enhancer-prompt.js";

interface ResolvedEnhanceConfig {
  model: NonNullable<ExtensionCommandContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
}

type EnhanceFn = (
  text: string,
  mode: EnhancerMode,
  signal?: AbortSignal,
  previousOutput?: string,
  onProgress?: (message: string) => void,
) => ReturnType<typeof enhancePrompt>;

const INLINE_STATUS_KEY = "pi-prompt-gen";
const INLINE_STATUS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INLINE_STATUS_INTERVAL_MS = 120;
const EDITOR_WRITE_WARNING = "Enhanced prompt ready, but failed to write to editor.";
const EDITOR_AND_CLIPBOARD_WARNING = "Enhanced prompt ready, but failed to write to editor or copy to clipboard.";
const CLIPBOARD_WRITE_WARNING = "Enhanced prompt written to editor, but failed to copy to clipboard.";
const NO_UI_ERROR_MESSAGE =
  "The /prompt command requires Pi TUI or an interactive UI-capable mode. " +
  "Use Pi TUI for the modal, or provide text inside a UI-capable session.";

export default function registerPiPromptGen(pi: ExtensionAPI): void {
  const runPromptCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    await ctx.waitForIdle();

    const initialText = resolveInitialText(args, ctx);
    const initialMode: EnhancerMode = initialText ? "rewrite" : "generate";
    const initialTextLabel = resolvePrefillLabel(args, ctx);
    const notify = (msg: string, type?: "info" | "warning" | "error") => ctx.ui.notify(msg, type);

    const enhanceConfig = await resolveEnhanceConfig(ctx);
    if (!enhanceConfig) return;

    const enhanceFn = createEnhanceFn(ctx, enhanceConfig, resolveBrowseToolNames(pi));

    if (args.trim()) {
      await runInlineEnhancement(ctx, initialText, initialMode, enhanceFn, notify);
      return;
    }

    if (ctx.mode !== "tui") {
      await runNonTuiFallback(ctx, initialText, initialMode, enhanceFn, notify);
      return;
    }

    const modal = new PromptGenModal({
      initialText,
      initialTextLabel,
      mode: initialMode,
      enhanceFn,
      copyFn: copyToClipboard,
      applyFn: (text: string) => {
        ctx.ui.setEditorText(text);
      },
      sendFn: createSendFn(pi, ctx),
      notifyFn: notify,
    });

    await ctx.ui.custom<{ draftText: string } | undefined>(
      (tui, theme, keybindings, done) => {
        modal.bind(theme, done, () => tui.requestRender(), keybindings);
        return modal;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "90%",
          maxHeight: "80%",
          anchor: "center",
        },
      },
    );
  };

  pi.registerCommand("prompt", {
    description:
      "Open the prompt enhancer modal, or run it inline when prompt text " +
      "is provided as the command argument. Rewrite an existing prompt or " +
      "turn a rough idea into a polished prompt. Use the current editor/" +
      "session text when starting without args, or start blank.",
    handler: runPromptCommand,
  });

  pi.registerShortcut("ctrl+shift+g", {
    description: "Open pi-prompt-gen modal",
    handler: async (ctx) => {
      if (typeof (ctx as Partial<ExtensionCommandContext>).waitForIdle === "function") {
        await runPromptCommand("", ctx as ExtensionCommandContext);
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait until the current run is idle before opening pi-prompt-gen.", "warning");
        return;
      }

      const initialText = resolveShortcutPrefill(ctx);
      const initialMode: EnhancerMode = initialText ? "rewrite" : "generate";
      const initialTextLabel = resolveShortcutPrefillLabel(ctx);

      if (ctx.mode !== "tui") {
        ctx.ui.notify("The global pi-prompt-gen shortcut is available in Pi TUI mode only.", "warning");
        return;
      }

      const enhanceConfig = await resolveEnhanceConfig(ctx as ExtensionCommandContext);
      if (!enhanceConfig) return;

      const enhanceFn = createEnhanceFn(ctx as ExtensionCommandContext, enhanceConfig, resolveBrowseToolNames(pi));
      const modal = new PromptGenModal({
        initialText,
        initialTextLabel,
        mode: initialMode,
        enhanceFn,
        copyFn: copyToClipboard,
        applyFn: (text: string) => {
          ctx.ui.setEditorText(text);
        },
        sendFn: createSendFn(pi, ctx),
        notifyFn: (msg, type) => ctx.ui.notify(msg, type),
      });

      await ctx.ui.custom<{ draftText: string } | undefined>(
        (tui, theme, keybindings, done) => {
          modal.bind(theme, done, () => tui.requestRender(), keybindings);
          return modal;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "90%",
            maxHeight: "80%",
            anchor: "center",
          },
        },
      );
    },
  });
}

function createEnhanceFn(
  ctx: ExtensionCommandContext,
  config: ResolvedEnhanceConfig,
  browseTools: string[],
): EnhanceFn {
  return async (
    text: string,
    mode: EnhancerMode,
    signal?: AbortSignal,
    previousOutput?: string,
    onProgress?: (message: string) => void,
  ) => {
    throwIfAborted(signal);

    const browseResult = ctx.cwd
      ? await browseCodebase({
        input: text,
        cwd: ctx.cwd,
        model: config.model,
        apiKey: config.apiKey,
        headers: config.headers,
        signal,
        tools: browseTools,
        sessionHistory: resolveBrowseSessionHistory(ctx.sessionManager),
        onProgress,
      })
      : { refs: [] };

    throwIfAborted(signal);
    onProgress?.("Generating enhanced prompt…");
    const result = await enhancePrompt({
      input: text,
      mode,
      cwd: ctx.cwd,
      model: config.model,
      apiKey: config.apiKey,
      headers: config.headers,
      signal,
      previousOutput,
      relevantRefs: browseResult.refs,
      gitContext: browseResult.gitContext,
      sessionContext: browseResult.sessionContext,
    });
    return {
      ...result,
      metadata: {
        ...result.metadata,
        browseToolsUsed: browseTools,
      },
    };
  };
}

function resolveBrowseToolNames(pi: ExtensionAPI): string[] {
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  return [...SAFE_BROWSE_TOOL_NAMES].filter((toolName) => available.has(toolName));
}

function createSendFn(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionCommandContext, "ui">,
): (text: string) => Promise<void> {
  return async (text: string) => {
    pi.sendUserMessage(text);

    try {
      ctx.ui.setEditorText("");
    } catch {
      ctx.ui.notify("Sent prompt, but failed to clear the editor.", "warning");
    }
  };
}

async function resolveEnhanceConfig(ctx: ExtensionCommandContext): Promise<ResolvedEnhanceConfig | undefined> {
  const model = ctx.model;
  if (!model) {
    ctx.ui.notify("No active model. Select a model before using /prompt.", "error");
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    ctx.ui.notify(`No API key configured for ${model.provider}: ${auth.error}`, "error");
    return undefined;
  }

  return {
    model,
    apiKey: auth.apiKey ?? "",
    headers: auth.headers,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;

  if (typeof DOMException === "function") {
    throw new DOMException("Prompt enhancement aborted", "AbortError");
  }

  const error = new Error("Prompt enhancement aborted");
  error.name = "AbortError";
  throw error;
}

// ---------------------------------------------------------------------------
// Prefill helpers
// ---------------------------------------------------------------------------

function resolveInitialText(args: string, ctx: ExtensionCommandContext): string {
  const fromArgs = args.trim();
  if (fromArgs) return fromArgs;
  return resolveShortcutPrefill(ctx);
}

function resolveShortcutPrefill(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui" | "sessionManager">): string {
  if (ctx.hasUI) {
    const editorText = ctx.ui.getEditorText()?.trim();
    if (editorText) return editorText;
  }

  const branchEntries = typeof ctx.sessionManager?.getBranch === "function"
    ? ctx.sessionManager.getBranch()
    : typeof ctx.sessionManager?.getEntries === "function"
      ? ctx.sessionManager.getEntries()
      : [];

  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = extractMessageText(entry.message.content);
    if (text) return text;
  }

  return "";
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type?: string; text?: string } => Boolean(item) && typeof item === "object")
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function resolveBrowseSessionHistory(
  sessionManager: Pick<ExtensionCommandContext, "sessionManager">["sessionManager"],
): BrowseSessionHistoryMessage[] {
  // Browse history must stay scoped to the current branch. Prefill can fall
  // back to getEntries(), but the internal session_history tool should not
  // risk exposing unrelated session-tree entries when getBranch() is absent.
  const branchEntries = typeof sessionManager?.getBranch === "function"
    ? sessionManager.getBranch()
    : [];

  const messages: BrowseSessionHistoryMessage[] = [];
  for (const entry of branchEntries) {
    const messageEntry = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (messageEntry?.type !== "message") continue;
    const role = messageEntry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractMessageText(messageEntry.message?.content);
    if (!text) continue;
    messages.push({ role, text });
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Prefill source labels
// ---------------------------------------------------------------------------

function resolvePrefillLabel(args: string, ctx: ExtensionCommandContext): string {
  if (args.trim()) return "from args";
  return resolveShortcutPrefillLabel(ctx);
}

function resolveShortcutPrefillLabel(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui" | "sessionManager">): string {
  if (ctx.hasUI) {
    const editorText = ctx.ui.getEditorText()?.trim();
    if (editorText) return "from editor";
  }

  const branchEntries = typeof ctx.sessionManager?.getBranch === "function"
    ? ctx.sessionManager.getBranch()
    : typeof ctx.sessionManager?.getEntries === "function"
      ? ctx.sessionManager.getEntries()
      : [];

  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = extractMessageText(entry.message.content);
    if (text) return "from session";
  }

  return "blank";
}

// ---------------------------------------------------------------------------
// Non-TUI fallback
// ---------------------------------------------------------------------------

async function runNonTuiFallback(
  ctx: ExtensionCommandContext,
  initialText: string,
  initialMode: EnhancerMode,
  enhanceFn: EnhanceFn,
  notify: (msg: string, type?: "info" | "warning" | "error") => void,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error(NO_UI_ERROR_MESSAGE);
  }

  const hasDialog = typeof ctx.ui.editor === "function";
  let text = initialText;

  if (!text && hasDialog) {
    const input = await ctx.ui.editor(
      initialMode === "rewrite"
        ? "Prompt to rewrite"
        : "Rough idea to turn into a prompt",
    );
    if (!input) {
      notify("Cancelled.", "info");
      return;
    }
    text = input;
  } else if (!text) {
    notify(
      "No input text and no dialog UI available. " +
        "Use /prompt <your prompt> or run inside Pi TUI.",
      "warning",
    );
    return;
  }

  await runInlineEnhancement(ctx, text, initialMode, enhanceFn, notify);
}

async function runInlineEnhancement(
  ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
  text: string,
  mode: EnhancerMode,
  enhanceFn: EnhanceFn,
  notify: (msg: string, type?: "info" | "warning" | "error") => void,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error(NO_UI_ERROR_MESSAGE);
  }

  const progress = createInlineStatusReporter(ctx);
  notify("Enhancing prompt…", "info");

  let output: string;
  let metadataSummary = "";
  try {
    const result = await enhanceFn(text, mode, undefined, undefined, (message) => {
      progress.update(message);
    });
    output = result.enhancedPrompt;
    // Build compact metadata summary for notification.
    const metaParts = buildMetadataSummaryParts(result.metadata);
    if (metaParts.length > 0) metadataSummary = ` \u00b7 ${metaParts.join(" \u00b7 ")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify(`Enhancement failed: ${msg}`, "error");
    progress.stop();
    return;
  }

  try {
    ctx.ui.setEditorText(output);
  } catch {
    progress.stop();
    try {
      await copyToClipboard(output);
      notify(EDITOR_WRITE_WARNING, "warning");
      notify(`Enhanced prompt copied to clipboard.${metadataSummary}`, "info");
    } catch {
      notify(EDITOR_AND_CLIPBOARD_WARNING, "warning");
    }
    return;
  }

  try {
    await copyToClipboard(output);
    notify(`Enhanced prompt copied to clipboard and written to editor.${metadataSummary}`, "info");
  } catch {
    notify(CLIPBOARD_WRITE_WARNING, "warning");
  } finally {
    progress.stop();
  }
}

function createInlineStatusReporter(
  ctx: Pick<ExtensionCommandContext, "ui">,
): { update: (message: string) => void; stop: () => void } {
  let message = "Enhancing prompt…";
  let frameIndex = 0;

  const render = () => {
    const theme = ctx.ui.theme;
    const frameText = INLINE_STATUS_FRAMES[frameIndex] ?? INLINE_STATUS_FRAMES[0]!;
    const messageText = ` prompt-gen: ${message}`;
    const frame = typeof theme?.fg === "function" ? theme.fg("accent", frameText) : frameText;
    const text = typeof theme?.fg === "function" ? theme.fg("dim", messageText) : messageText;
    ctx.ui.setStatus(INLINE_STATUS_KEY, `${frame}${text}`);
  };

  render();

  const timer = setInterval(() => {
    frameIndex = (frameIndex + 1) % INLINE_STATUS_FRAMES.length;
    render();
  }, INLINE_STATUS_INTERVAL_MS);

  return {
    update(nextMessage: string) {
      const normalized = nextMessage.trim();
      if (!normalized) return;
      message = normalized;
      render();
    },
    stop() {
      clearInterval(timer);
      ctx.ui.setStatus(INLINE_STATUS_KEY, undefined);
    },
  };
}

export { enhancePrompt } from "../src/index.js";
export type {
  EnhancePromptOptions,
  EnhancePromptResult,
  Ref,
} from "../src/index.js";
