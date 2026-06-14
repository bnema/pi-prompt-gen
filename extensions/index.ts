/**
 * pi-prompt-gen extension entry point (Phases 3 & 4).
 *
 * Registers the /prompt command that opens the modal prompt enhancer.
 *
 * Prefill rules:
 *  1. If command args are provided → use them as draft text.
 *  2. Else if editor has non-empty text → prefill with editor text.
 *  3. Otherwise → start blank (generate mode).
 *
 * In TUI mode: opens the full modal overlay.
 * Outside TUI: falls back to an editor() dialog, or notifies the user.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { enhancePrompt } from "../src/index.js";
import { PromptGenModal } from "../src/modal.js";
import type { EnhancerMode } from "../src/enhancer-prompt.js";

export default function registerPiPromptGen(pi: ExtensionAPI): void {
  const runPromptCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    await ctx.waitForIdle();

    const initialText = resolveInitialText(args, ctx);
    const initialMode: EnhancerMode = initialText ? "rewrite" : "generate";

    const model = ctx.model;
    if (!model) {
      ctx.ui.notify(
        "No active model. Select a model before using /prompt.",
        "error",
      );
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(
        `No API key configured for ${model.provider}: ${auth.error}`,
        "error",
      );
      return;
    }

    const enhanceFn = (
      text: string,
      mode: EnhancerMode,
      signal?: AbortSignal,
      previousOutput?: string,
    ) =>
      enhancePrompt({
        input: text,
        mode,
        cwd: ctx.cwd,
        model,
        apiKey: auth.apiKey ?? "",
        headers: auth.headers,
        signal,
        previousOutput,
      });

    const notify = (msg: string, type?: "info" | "warning" | "error") =>
      ctx.ui.notify(msg, type);

    if (ctx.mode !== "tui") {
      await runNonTuiFallback(ctx, initialText, initialMode, enhanceFn, pi, notify);
      return;
    }

    const modal = new PromptGenModal({
      initialText,
      mode: initialMode,
      enhanceFn,
      copyFn: copyToClipboard,
      applyFn: (text: string) => {
        ctx.ui.setEditorText(text);
      },
      sendFn: (text: string) => {
        try {
          pi.sendUserMessage(text);
        } catch {
          pi.sendUserMessage(text, { deliverAs: "followUp" });
        }
      },
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
      "Open the prompt enhancer modal. Rewrite an existing prompt or " +
      "turn a rough idea into a polished prompt. " +
      "Provide the prompt text as the command argument, or use the " +
      "current editor/session text, or start blank.",
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
      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No active model. Select a model before using pi-prompt-gen.", "error");
        return;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        ctx.ui.notify(`No API key configured for ${model.provider}: ${auth.error}`, "error");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("The global pi-prompt-gen shortcut is available in Pi TUI mode only.", "warning");
        return;
      }

      const enhanceFn = (
        text: string,
        mode: EnhancerMode,
        signal?: AbortSignal,
        previousOutput?: string,
      ) =>
        enhancePrompt({
          input: text,
          mode,
          cwd: ctx.cwd,
          model,
          apiKey: auth.apiKey ?? "",
          headers: auth.headers,
          signal,
          previousOutput,
        });

      const modal = new PromptGenModal({
        initialText,
        mode: initialMode,
        enhanceFn,
        copyFn: copyToClipboard,
        applyFn: (text: string) => {
          ctx.ui.setEditorText(text);
        },
        sendFn: (text: string) => {
          try {
            pi.sendUserMessage(text);
          } catch {
            pi.sendUserMessage(text, { deliverAs: "followUp" });
          }
        },
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

// ---------------------------------------------------------------------------
// Non-TUI fallback
// ---------------------------------------------------------------------------

async function runNonTuiFallback(
  ctx: ExtensionCommandContext,
  initialText: string,
  initialMode: EnhancerMode,
  enhanceFn: (text: string, mode: EnhancerMode, signal?: AbortSignal, previousOutput?: string) => ReturnType<typeof enhancePrompt>,
  pi: ExtensionAPI,
  notify: (msg: string, type?: "info" | "warning" | "error") => void,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error(
      "The /prompt command requires Pi TUI or an interactive UI-capable mode. " +
        "Use Pi TUI for the modal, or provide text inside a UI-capable session.",
    );
  }

  const hasDialog = typeof ctx.ui.editor === "function";

  // Get text from user (prefill if available)
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

  // Run enhancement
  notify("Enhancing prompt…", "info");
  try {
    const result = await enhanceFn(text, initialMode);
    const output = result.enhancedPrompt;

    // Write to editor if available
    if (ctx.hasUI) {
      ctx.ui.setEditorText(output);
    }

    // Copy to clipboard as a convenience
    await copyToClipboard(output);
    notify(
      `Enhanced prompt copied to clipboard${ctx.hasUI ? " and written to editor" : ""}.`,
      "info",
    );
    void pi; // captured for potential send in future
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify(`Enhancement failed: ${msg}`, "error");
  }
}

// Re-export the composed core function and its types for programmatic use.
export { enhancePrompt } from "../src/index.js";
export type {
  EnhancePromptOptions,
  EnhancePromptResult,
} from "../src/index.js";
