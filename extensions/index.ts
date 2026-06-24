/**
 * pi-prompt-gen extension entry point.
 *
 * Registers the /prompt command for modal or inline prompt enhancement.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { browseCodebase, SAFE_BROWSE_TOOL_NAMES, type BrowseSessionHistoryMessage } from "../src/browse-pass.js";
import { enhancePrompt } from "../src/index.js";
import { buildMetadataSummaryParts } from "../src/debug-artifact.js";
import { PromptGenModal } from "../src/modal.js";
import type { EnhancerMode } from "../src/enhancer-prompt.js";

interface ResolvedEnhanceConfig {
  model: NonNullable<ExtensionContext["model"]>;
  apiKey?: string;
  headers?: Record<string, string>;
}

type EnhanceContext = Pick<ExtensionContext, "cwd" | "modelRegistry" | "sessionManager" | "ui">;
type EnhanceModelContext = Pick<ExtensionContext, "model" | "modelRegistry" | "ui">;

interface PromptGenPersistedSettings {
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: ModelThinkingLevel;
}

interface PromptGenSelection {
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
}

type EnhanceFn = (
  text: string,
  mode: EnhancerMode,
  signal?: AbortSignal,
  previousOutput?: string,
  onProgress?: (message: string) => void,
  selection?: { model?: Model<Api>; thinkingLevel?: ModelThinkingLevel },
) => ReturnType<typeof enhancePrompt>;

const INLINE_STATUS_KEY = "pi-prompt-gen";
const INLINE_STATUS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INLINE_STATUS_INTERVAL_MS = 120;
const EDITOR_WRITE_WARNING = "Enhanced prompt ready, but failed to write to editor.";
const EDITOR_AND_CLIPBOARD_WARNING = "Enhanced prompt ready, but failed to write to editor or copy to clipboard.";
const CLIPBOARD_WRITE_WARNING = "Enhanced prompt written to editor, but failed to copy to clipboard.";
const ENHANCED_COPY_WARNING = "Enhanced prompt ready, but failed to copy to clipboard.";
const INLINE_INPUT_BACKUP_WARNING = "Could not copy original prompt to clipboard before enhancement; continuing.";
const INPUT_ENHANCE_CONFIRM_TITLE = "Would you like to enhance this prompt?";
const INPUT_ENHANCE_YES = "Yes";
const INPUT_ENHANCE_NO = "No";
const INPUT_ENHANCE_DISABLE_SESSION = "Don't ask again for this session";
const INPUT_ENHANCE_CHOICES = [
  INPUT_ENHANCE_YES,
  INPUT_ENHANCE_NO,
  INPUT_ENHANCE_DISABLE_SESSION,
];
type InputEnhanceDefaultChoice = typeof INPUT_ENHANCE_YES | typeof INPUT_ENHANCE_NO;
const NO_UI_ERROR_MESSAGE =
  "The /prompt command requires Pi TUI or an interactive UI-capable mode. " +
  "Use Pi TUI for the modal, or provide text inside a UI-capable session.";
const GLOBAL_SETTINGS_FILE = "prompt-gen-settings.json";
const VALID_THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export default function registerPiPromptGen(pi: ExtensionAPI): void {
  let inputEnhancementDisabledForSession = false;
  let inputEnhancementDefaultChoice: InputEnhanceDefaultChoice = INPUT_ENHANCE_YES;

  pi.on("session_start", () => {
    inputEnhancementDisabledForSession = false;
    inputEnhancementDefaultChoice = INPUT_ENHANCE_YES;
  });

  const runPromptCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    await ctx.waitForIdle();

    const initialText = resolveInitialText(args, ctx);
    const initialMode: EnhancerMode = initialText ? "rewrite" : "generate";
    const initialTextLabel = resolvePrefillLabel(args, ctx);
    const notify = (msg: string, type?: "info" | "warning" | "error") => ctx.ui.notify(msg, type);

    const browseTools = resolveBrowseToolNames(pi);

    if (args.trim()) {
      const enhanceConfig = await resolveEnhanceConfig(ctx);
      if (!enhanceConfig) return;
      await runInlineEnhancement(ctx, initialText, initialMode, createEnhanceFn(ctx, enhanceConfig, browseTools), notify);
      return;
    }

    if (ctx.mode !== "tui") {
      const enhanceConfig = await resolveEnhanceConfig(ctx);
      if (!enhanceConfig) return;
      await runNonTuiFallback(ctx, initialText, initialMode, createEnhanceFn(ctx, enhanceConfig, browseTools), notify);
      return;
    }

    const enhanceConfig = resolveEnhanceModelConfig(ctx);
    if (!enhanceConfig) return;

    await openPromptGenModal(pi, ctx, {
      initialText,
      initialTextLabel,
      initialMode,
      enhanceConfig,
      browseTools,
      notify,
    });
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

      const enhanceConfig = resolveEnhanceModelConfig(ctx as ExtensionCommandContext);
      if (!enhanceConfig) return;

      await openPromptGenModal(pi, ctx as ExtensionCommandContext, {
        initialText,
        initialTextLabel,
        initialMode,
        enhanceConfig,
        browseTools: resolveBrowseToolNames(pi),
        notify: (msg: string, type?: "info" | "warning" | "error") => ctx.ui.notify(msg, type),
      });
    },
  });

  pi.on("input", async (event, ctx) => {
    if (
      inputEnhancementDisabledForSession ||
      event.streamingBehavior !== undefined ||
      shouldSkipInputEnhancement(event.source, event.text) ||
      !ctx.hasUI
    ) {
      return { action: "continue" };
    }

    const choice = await ctx.ui.select(
      INPUT_ENHANCE_CONFIRM_TITLE,
      inputEnhanceChoicesForDefault(inputEnhancementDefaultChoice),
    );
    if (choice === INPUT_ENHANCE_DISABLE_SESSION) {
      inputEnhancementDisabledForSession = true;
      return { action: "continue" };
    }
    if (choice === INPUT_ENHANCE_NO) {
      inputEnhancementDefaultChoice = INPUT_ENHANCE_NO;
      return { action: "continue" };
    }
    if (choice !== INPUT_ENHANCE_YES) return { action: "continue" };
    inputEnhancementDefaultChoice = INPUT_ENHANCE_YES;

    const enhanceConfig = await resolveEnhanceConfig(ctx);
    if (!enhanceConfig) return { action: "continue" };

    const enhancedPrompt = await runInlineEnhancement(
      ctx,
      event.text,
      "rewrite",
      createEnhanceFn(ctx, enhanceConfig, resolveBrowseToolNames(pi)),
      (msg, type) => ctx.ui.notify(msg, type),
      { writeResultToEditor: false, writeResultToClipboard: false },
    );

    if (!enhancedPrompt) return { action: "continue" };

    return {
      action: "transform",
      text: enhancedPrompt,
      ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
    };
  });
}

function shouldSkipInputEnhancement(source: string, text: string): boolean {
  const trimmed = text.trim();
  return source === "extension" || trimmed.length === 0 || trimmed.startsWith("/");
}

function inputEnhanceChoicesForDefault(defaultChoice: InputEnhanceDefaultChoice): string[] {
  if (defaultChoice === INPUT_ENHANCE_NO) {
    return [INPUT_ENHANCE_NO, INPUT_ENHANCE_YES, INPUT_ENHANCE_DISABLE_SESSION];
  }
  return INPUT_ENHANCE_CHOICES;
}

interface OpenPromptGenModalOptions {
  initialText: string;
  initialTextLabel: string;
  initialMode: EnhancerMode;
  enhanceConfig: ResolvedEnhanceConfig;
  browseTools: string[];
  notify: (msg: string, type?: "info" | "warning" | "error") => void;
}

async function openPromptGenModal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: OpenPromptGenModalOptions,
): Promise<void> {
  const availableModels = resolveAvailableModels(ctx, options.enhanceConfig.model);
  let currentSelection = resolveInitialSelection(ctx, availableModels, options.enhanceConfig.model);
  const persistSelection = () => persistPromptGenSelection(currentSelection);
  const enhanceFn = createEnhanceFn(ctx, options.enhanceConfig, options.browseTools, () => currentSelection);

  const modal = new PromptGenModal({
    initialText: options.initialText,
    initialTextLabel: options.initialTextLabel,
    mode: options.initialMode,
    enhanceFn,
    availableModels,
    selectedModel: currentSelection.model,
    selectedThinkingLevel: currentSelection.thinkingLevel,
    onSelectionChange: (selection) => {
      currentSelection = selection;
      persistSelection();
    },
    copyFn: copyToClipboard,
    applyFn: (text: string) => {
      ctx.ui.setEditorText(text);
    },
    sendFn: createSendFn(pi, ctx),
    notifyFn: options.notify,
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
}

function createEnhanceFn(
  ctx: EnhanceContext,
  config: ResolvedEnhanceConfig,
  browseTools: string[],
  getSelection?: () => PromptGenSelection,
): EnhanceFn {
  return async (
    text: string,
    mode: EnhancerMode,
    signal?: AbortSignal,
    previousOutput?: string,
    onProgress?: (message: string) => void,
    selectionOverride?: { model?: Model<Api>; thinkingLevel?: ModelThinkingLevel },
  ) => {
    throwIfAborted(signal);

    const selection = resolveEffectiveSelection(config.model, getSelection?.(), selectionOverride);
    const canReuseConfig = selection.model.provider === config.model.provider &&
      selection.model.id === config.model.id &&
      config.apiKey !== undefined;
    const selectedConfig = canReuseConfig
      ? config
      : await resolveEnhanceConfigForModel(ctx, selection.model);
    if (!selectedConfig) throw new Error(`No API key configured for ${selection.model.provider}.`);
    const selectedApiKey = selectedConfig.apiKey ?? "";

    const browseResult = ctx.cwd
      ? await browseCodebase({
        input: text,
        cwd: ctx.cwd,
        model: selectedConfig.model,
        apiKey: selectedApiKey,
        headers: selectedConfig.headers,
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
      model: selectedConfig.model,
      apiKey: selectedApiKey,
      headers: selectedConfig.headers,
      signal,
      thinkingLevel: selection.thinkingLevel,
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

function resolveEnhanceModelConfig(ctx: EnhanceModelContext): ResolvedEnhanceConfig | undefined {
  const model = ctx.model;
  if (!model) {
    ctx.ui.notify("No active model. Select a model before using /prompt.", "error");
    return undefined;
  }

  return { model };
}

async function resolveEnhanceConfig(ctx: EnhanceModelContext): Promise<ResolvedEnhanceConfig | undefined> {
  const modelConfig = resolveEnhanceModelConfig(ctx);
  if (!modelConfig) return undefined;
  return resolveEnhanceConfigForModel(ctx, modelConfig.model, true);
}

async function resolveEnhanceConfigForModel(
  ctx: Pick<ExtensionContext, "modelRegistry" | "ui">,
  model: Model<Api>,
  notify = false,
): Promise<ResolvedEnhanceConfig | undefined> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    if (notify) ctx.ui.notify(`No API key configured for ${model.provider}: ${auth.error}`, "error");
    return undefined;
  }

  return {
    model,
    apiKey: auth.apiKey ?? "",
    headers: auth.headers,
  };
}

function resolveAvailableModels(ctx: ExtensionCommandContext, fallbackModel: Model<Api>): Model<Api>[] {
  const available = typeof ctx.modelRegistry.getAvailable === "function"
    ? ctx.modelRegistry.getAvailable()
    : [];
  const allModels = Array.isArray(available) ? [...available] : [];
  const enabledModels = resolveEnabledModelPatterns(ctx);
  const models = enabledModels?.length ? filterModelsByPatterns(allModels, enabledModels) : allModels;
  return ensureModelIncluded(models, fallbackModel);
}

function resolveEnabledModelPatterns(ctx: ExtensionCommandContext): string[] | undefined {
  try {
    const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    return settingsManager.getEnabledModels();
  } catch {
    return undefined;
  }
}

function filterModelsByPatterns(models: Model<Api>[], patterns: string[]): Model<Api>[] {
  const result: Model<Api>[] = [];
  for (const pattern of patterns) {
    const normalized = stripThinkingSuffix(pattern.trim().toLowerCase());
    if (!normalized) continue;
    for (const model of models) {
      if (!modelMatchesPattern(model, normalized)) continue;
      if (!result.some((existing) => sameModel(existing, model))) result.push(model);
    }
  }
  return result;
}

function modelMatchesPattern(model: Model<Api>, pattern: string): boolean {
  const providerId = `${model.provider}/${model.id}`.toLowerCase();
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  const provider = model.provider.toLowerCase();
  return wildcardMatch(providerId, pattern) ||
    wildcardMatch(id, pattern) ||
    wildcardMatch(name, pattern) ||
    wildcardMatch(provider, pattern);
}

function stripThinkingSuffix(pattern: string): string {
  const suffixMatch = pattern.match(/:(off|minimal|low|medium|high|xhigh)$/);
  return suffixMatch ? pattern.slice(0, -suffixMatch[0].length) : pattern;
}

function wildcardMatch(value: string, pattern: string): boolean {
  try {
    // Patterns come from trusted Pi enabledModels settings; non-glob characters
    // are escaped and matched model/provider strings are short, bounded IDs.
    const regex = globPatternToRegExp(pattern);
    return regex.test(value);
  } catch {
    return false;
  }
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      source += ".*";
    } else if (ch === "?") {
      source += ".";
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close > i + 1) {
        source += pattern.slice(i, close + 1);
        i = close;
      } else {
        source += "\\[";
      }
    } else {
      source += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "i");
}

function ensureModelIncluded(models: Model<Api>[], fallbackModel: Model<Api>): Model<Api>[] {
  const result = [...models];
  if (!result.some((model) => sameModel(model, fallbackModel))) result.unshift(fallbackModel);
  return result;
}

function sameModel(a: Model<Api>, b: Model<Api>): boolean {
  return a.provider === b.provider && a.id === b.id;
}

function resolveInitialSelection(
  _ctx: ExtensionCommandContext,
  availableModels: Model<Api>[],
  fallbackModel: Model<Api>,
): PromptGenSelection {
  const persisted = readPersistedPromptGenSettings();
  const persistedModel = persisted?.modelProvider && persisted.modelId
    ? availableModels.find((model) => model.provider === persisted.modelProvider && model.id === persisted.modelId)
    : undefined;
  const model = persistedModel ?? fallbackModel;
  return {
    model,
    thinkingLevel: normalizeThinkingLevel(model, persisted?.thinkingLevel),
  };
}

function readPersistedPromptGenSettings(): PromptGenPersistedSettings | undefined {
  try {
    const raw = readFileSync(getGlobalSettingsPath(), "utf8");
    const data = JSON.parse(raw) as PromptGenPersistedSettings | undefined;
    if (!data || typeof data !== "object") return undefined;
    if (typeof data.modelProvider !== "string" || typeof data.modelId !== "string") return undefined;
    if (data.thinkingLevel !== undefined && !VALID_THINKING_LEVELS.has(data.thinkingLevel)) return undefined;
    return data;
  } catch {
    return undefined;
  }
}

function persistPromptGenSelection(selection: PromptGenSelection): void {
  const path = getGlobalSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    modelProvider: selection.model.provider,
    modelId: selection.model.id,
    thinkingLevel: selection.thinkingLevel,
  }, null, 2));
}

function getGlobalSettingsPath(): string {
  return join(getAgentDir(), GLOBAL_SETTINGS_FILE);
}

function resolveEffectiveSelection(
  defaultModel: Model<Api>,
  currentSelection?: PromptGenSelection,
  override?: { model?: Model<Api>; thinkingLevel?: ModelThinkingLevel },
): { model: Model<Api>; thinkingLevel?: ModelThinkingLevel } {
  const model = override?.model ?? currentSelection?.model ?? defaultModel;
  const explicitLevel = override?.thinkingLevel ?? currentSelection?.thinkingLevel;
  const thinkingLevel = explicitLevel ? normalizeThinkingLevel(model, explicitLevel) : undefined;
  return { model, thinkingLevel };
}

function normalizeThinkingLevel(model: Model<Api>, level: ModelThinkingLevel | undefined): ModelThinkingLevel {
  return clampThinkingLevel(model, level ?? "off");
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
  sessionManager: ExtensionContext["sessionManager"],
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

  await runInlineEnhancement(ctx, text, initialMode, enhanceFn, notify, {
    writeResultToClipboard: true,
  });
}

interface RunInlineEnhancementOptions {
  writeResultToEditor?: boolean;
  writeResultToClipboard?: boolean;
}

async function runInlineEnhancement(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  text: string,
  mode: EnhancerMode,
  enhanceFn: EnhanceFn,
  notify: (msg: string, type?: "info" | "warning" | "error") => void,
  options: RunInlineEnhancementOptions = {},
): Promise<string | undefined> {
  if (!ctx.hasUI) {
    throw new Error(NO_UI_ERROR_MESSAGE);
  }

  const progress = createInlineStatusReporter(ctx);
  notify("Enhancing prompt…", "info");
  await backupInlineInputToClipboard(text, notify);

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
    return undefined;
  }

  const writeResultToEditor = options.writeResultToEditor ?? true;
  const writeResultToClipboard = options.writeResultToClipboard ?? true;

  if (writeResultToEditor) {
    try {
      ctx.ui.setEditorText(output);
    } catch {
      progress.stop();
      if (!writeResultToClipboard) {
        notify(EDITOR_WRITE_WARNING, "warning");
        return output;
      }
      try {
        await copyToClipboard(output);
        notify(EDITOR_WRITE_WARNING, "warning");
        notify(`Enhanced prompt copied to clipboard.${metadataSummary}`, "info");
      } catch {
        notify(EDITOR_AND_CLIPBOARD_WARNING, "warning");
      }
      return output;
    }
  }

  if (!writeResultToClipboard) {
    notify(
      writeResultToEditor
        ? `Enhanced prompt written to editor.${metadataSummary}`
        : `Enhanced prompt ready.${metadataSummary}`,
      "info",
    );
    progress.stop();
    return output;
  }

  try {
    await copyToClipboard(output);
    notify(
      writeResultToEditor
        ? `Enhanced prompt copied to clipboard and written to editor.${metadataSummary}`
        : `Enhanced prompt copied to clipboard.${metadataSummary}`,
      "info",
    );
  } catch {
    notify(writeResultToEditor ? CLIPBOARD_WRITE_WARNING : ENHANCED_COPY_WARNING, "warning");
  } finally {
    progress.stop();
  }

  return output;
}

async function backupInlineInputToClipboard(
  text: string,
  notify: (msg: string, type?: "info" | "warning" | "error") => void,
): Promise<void> {
  try {
    await copyToClipboard(text);
  } catch {
    notify(INLINE_INPUT_BACKUP_WARNING, "warning");
  }
}

function createInlineStatusReporter(
  ctx: Pick<ExtensionContext, "ui">,
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
