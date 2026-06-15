/**
 * Isolated read-only browse pass for pi-prompt-gen.
 *
 * Uses a temporary AgentSession with the active model and a safe tool allowlist
 * to examine the codebase, then returns a minimal JSON list of relevant refs.
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Ref } from "./index.js";

const DEFAULT_MAX_REFS = 5;

export const SAFE_BROWSE_TOOL_NAMES = new Set([
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

interface ParsedRef {
  path: string;
  score: number;
  isEntrypoint: boolean;
}

export interface BrowseCodebaseOptions {
  input: string;
  cwd: string;
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  tools: string[];
  signal?: AbortSignal;
  maxRefs?: number;
  onProgress?: (message: string) => void;
}

export async function browseCodebase(options: BrowseCodebaseOptions): Promise<Ref[]> {
  const {
    input,
    cwd,
    model,
    apiKey,
    headers,
    tools,
    signal,
    maxRefs: rawMaxRefs = DEFAULT_MAX_REFS,
    onProgress,
  } = options;

  const maxRefs = normalizeMaxRefs(rawMaxRefs);
  const safeTools = filterSafeBrowseTools(tools);

  throwIfAborted(signal);
  if (!cwd || safeTools.length === 0) return [];

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, apiKey);

  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    api: model.api,
    headers,
  });

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noSkills: true,
    noContextFiles: true,
    systemPromptOverride: () => buildBrowseSystemPrompt(maxRefs),
  });
  await loader.reload();
  throwIfAborted(signal);

  const { session } = await createAgentSession({
    cwd,
    agentDir: getAgentDir(),
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    tools: safeTools,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });

  let unsubscribe = () => {};
  const abort = () => {
    void session.abort();
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    if (signal?.aborted) abort();
    throwIfAborted(signal);

    unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        onProgress?.(describeToolExecution(event.toolName, event.args));
      }
    });

    onProgress?.("Examining codebase…");
    await session.prompt(buildBrowseUserPrompt(input, maxRefs));
    throwIfAborted(signal);

    onProgress?.("Selecting useful references…");
    const responseText = extractLastAssistantText(session.messages);
    const parsedRefs = parseRefs(responseText);
    return await sanitizeRefs(parsedRefs, cwd, maxRefs);
  } finally {
    signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}

function buildBrowseSystemPrompt(maxRefs: number): string {
  return [
    "You are a codebase browsing scout.",
    "Use only the available read-only and information tools to inspect the repository and any available documentation search tools.",
    "Do not edit files, do not propose code changes, and do not solve the task.",
    "Your only job is to identify the smallest useful set of files a later prompt-enhancement model should reference.",
    "",
    "Return ONLY JSON in this shape:",
    '{"refs":[{"path":"src/file.ts","score":97,"isEntrypoint":false}]}',
    `Return at most ${maxRefs} refs.`,
    "Never invent paths. Only return files you actually inspected or directly inferred from inspected code and tool results.",
  ].join("\n");
}

function buildBrowseUserPrompt(input: string, maxRefs: number): string {
  return [
    "Task to prepare for:",
    input,
    "",
    `Browse the codebase and return at most ${maxRefs} file refs that would best ground a later prompt rewrite.`,
    "Prefer entry points, primary implementation files, and the smallest useful support files.",
  ].join("\n");
}

function extractLastAssistantText(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((content): content is { type: "text"; text: string } => {
        return Boolean(content)
          && typeof content === "object"
          && (content as { type?: unknown }).type === "text"
          && typeof (content as { text?: unknown }).text === "string";
      })
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function parseRefs(content: string): ParsedRef[] {
  const parsed = parseJsonObject(content);
  const rawRefs =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { refs?: unknown }).refs)
      ? (parsed as { refs: unknown[] }).refs
      : [];

  const refs: ParsedRef[] = [];
  for (const rawRef of rawRefs) {
    if (!rawRef || typeof rawRef !== "object") continue;

    const path = typeof (rawRef as { path?: unknown }).path === "string"
      ? (rawRef as { path: string }).path.trim()
      : "";
    if (!path) continue;

    refs.push({
      path,
      score: clampScore((rawRef as { score?: unknown }).score),
      isEntrypoint: typeof (rawRef as { isEntrypoint?: unknown }).isEntrypoint === "boolean"
        ? (rawRef as { isEntrypoint: boolean }).isEntrypoint
        : false,
    });
  }

  return refs;
}

async function sanitizeRefs(parsedRefs: ParsedRef[], cwd: string, maxRefs: number): Promise<Ref[]> {
  const refs: Ref[] = [];
  const seen = new Set<string>();
  const limit = normalizeMaxRefs(maxRefs);
  const canonicalCwd = await realpath(cwd);

  for (const parsedRef of parsedRefs) {
    if (refs.length >= limit) break;

    const path = await normalizeRepoRelativePath(canonicalCwd, parsedRef.path);
    if (!path || seen.has(path)) continue;

    seen.add(path);
    refs.push({
      path,
      score: parsedRef.score,
      isEntrypoint: parsedRef.isEntrypoint,
    });
  }

  return refs;
}

async function normalizeRepoRelativePath(canonicalCwd: string, rawPath: string): Promise<string | undefined> {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;

  const requestedPath = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(canonicalCwd, trimmed);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
    const stats = await stat(canonicalPath);
    if (!stats.isFile()) return undefined;
  } catch {
    return undefined;
  }

  const relativePath = relative(canonicalCwd, canonicalPath);
  if (!relativePath || relativePath === "." || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    return undefined;
  }

  return relativePath.split(sep).join("/");
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  for (const candidate of [
    trimmed,
    trimmed.match(/```json\s*([\s\S]*?)```/i)?.[1],
    trimmed.match(/\{[\s\S]*\}/)?.[0],
  ]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next extraction strategy.
    }
  }
  return undefined;
}

function clampScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function describeToolExecution(toolName: string, args: unknown): string {
  switch (toolName) {
    case "read":
      return `Reading ${readStringArg(args, "path") ?? "files"}…`;
    case "grep":
      return `Searching ${readStringArg(args, "path") ?? "the repo"}…`;
    case "find":
      return "Finding matching files…";
    case "ls":
      return `Listing ${readStringArg(args, "path") ?? "directories"}…`;
    case "code_search":
      return "Searching code/docs…";
    case "project_memory_search":
      return "Searching project memory…";
    case "project_memory_read":
      return "Reading project memory…";
    case "codegraph_explore":
      return "Exploring indexed code graph…";
    case "codegraph_node":
      return "Inspecting code graph node…";
    default:
      return `Using ${toolName}…`;
  }
}

function readStringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function filterSafeBrowseTools(tools: string[]): string[] {
  const seen = new Set<string>();
  const safeTools: string[] = [];

  for (const tool of tools) {
    if (!SAFE_BROWSE_TOOL_NAMES.has(tool) || seen.has(tool)) continue;
    seen.add(tool);
    safeTools.push(tool);
  }

  return safeTools;
}

function normalizeMaxRefs(maxRefs: number): number {
  if (!Number.isFinite(maxRefs)) return DEFAULT_MAX_REFS;
  return Math.max(1, Math.floor(maxRefs));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;

  if (typeof DOMException === "function") {
    throw new DOMException("Browse pass aborted", "AbortError");
  }

  const error = new Error("Browse pass aborted");
  error.name = "AbortError";
  throw error;
}
