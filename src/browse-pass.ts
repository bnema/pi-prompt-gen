/**
 * Isolated read-only browse pass for pi-prompt-gen.
 *
 * Uses a temporary AgentSession with the active model, a safe tool allowlist,
 * and a small set of internal read-only browse tools to inspect the codebase,
 * current git context, and bounded current-branch conversation context. It
 * returns a small structured JSON payload for the final prompt-enhancement
 * model.
 */

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ChangedFileDetail, GitContext, Ref, SessionContext, SessionContextMessage } from "./index.js";
import {
  MAX_REASON_CHARS,
  MAX_ROLE_CHARS,
  MAX_SYMBOLS,
  MAX_SYMBOL_CHARS,
} from "./ref-metadata.js";

const DEFAULT_MAX_REFS = 5;
const INTERNAL_GIT_TOOL_NAME = "git_context";
const INTERNAL_SESSION_HISTORY_TOOL_NAME = "session_history";
const DEFAULT_HISTORY_PAGE_SIZE = 5;
const MAX_HISTORY_PAGE_SIZE = 10;
const MAX_HISTORY_SNAPSHOT_MESSAGES = 40;
const MAX_HISTORY_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_TOTAL_CHARS = 20_000;
const MAX_CHANGED_FILES = 12;
const MAX_SELECTED_MESSAGES = 4;
const MAX_SELECTED_MESSAGE_CHARS = 500;
const MAX_GIT_SUMMARY_CHARS = 600;
const MAX_GIT_DIFF_CHARS = 4_000;
const DEFAULT_GIT_DIFF_LINES = 120;
const MAX_GIT_DIFF_LINES = 200;
const DEFAULT_GIT_DIFF_BYTES = 12_000;
const MAX_GIT_DIFF_BYTES = 20_000;
const GIT_COMMAND_TIMEOUT_MS = 1_500;
const GIT_COMMAND_MAX_BYTES = 64 * 1024;
const GIT_PATH_DECODER = new TextDecoder("utf-8", { fatal: false });

const SAFE_BROWSE_TOOL_NAME_VALUES = [
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
] as const;

const RUNTIME_SAFE_BROWSE_TOOL_NAMES = new Set<string>(SAFE_BROWSE_TOOL_NAME_VALUES);

/** Immutable test-facing snapshot of the external browse tool allowlist. */
export const SAFE_BROWSE_TOOL_NAMES: readonly string[] = Object.freeze([...SAFE_BROWSE_TOOL_NAME_VALUES]);

interface ParsedRef {
  path: string;
  score: number;
  isEntrypoint: boolean;
  reason?: string;
  role?: string;
  symbols?: string[];
}

export interface BrowseSessionHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface BrowseCodebaseResult {
  refs: Ref[];
  gitContext?: GitContext;
  sessionContext?: SessionContext;
}

export interface BrowseCodebaseOptions {
  input: string;
  cwd: string;
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  tools: string[];
  sessionHistory?: BrowseSessionHistoryMessage[];
  signal?: AbortSignal;
  maxRefs?: number;
  onProgress?: (message: string) => void;
}

type CompatCreateAgentSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]> & {
  /**
   * OMP renamed the legacy Pi `tools` option to `toolNames`.
   * Keep both fields at runtime so the isolated browse scout receives the same
   * active tool set in both hosts without dropping vanilla Pi compatibility.
   */
  toolNames?: string[];
  /**
   * OMP-only isolation switches. The browse scout must not inherit arbitrary
   * host extensions, project custom tools, or MCP servers; only the explicit
   * safe tool names plus the internal SDK customTools are intended.
   */
  disableExtensionDiscovery?: boolean;
  preloadedCustomToolPaths?: [];
  enableMCP?: boolean;
};

interface ParsedBrowseResult {
  refs: ParsedRef[];
  gitContext?: GitContext;
  sessionContext?: SessionContext;
}

interface ChangedFileDetailPayload {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  additions?: number;
  deletions?: number;
}

interface GitSummaryPayload {
  branch?: string;
  statusSummary?: string;
  changedFiles?: string[];
  diffSummary?: string;
  changedFileDetails?: ChangedFileDetailPayload[];
}

interface GitDiffPayload {
  scope: "working_tree" | "staged";
  diff: string;
  truncated: boolean;
  paths?: string[];
}

interface GitToolDetails {
  kind: "summary" | "diff";
  branch?: string;
  statusSummary?: string;
  changedFiles?: string[];
  diffSummary?: string;
  changedFileDetails?: ChangedFileDetailPayload[];
  scope?: "working_tree" | "staged";
  diff?: string;
  truncated?: boolean;
  paths?: string[];
}

interface ObservedBrowseContext {
  gitSummary?: GitSummaryPayload;
  sessionHistory: BrowseSessionHistoryMessage[];
}

export async function browseCodebase(options: BrowseCodebaseOptions): Promise<BrowseCodebaseResult> {
  const {
    input,
    cwd,
    model,
    apiKey,
    headers,
    tools,
    sessionHistory = [],
    signal,
    maxRefs: rawMaxRefs = DEFAULT_MAX_REFS,
    onProgress,
  } = options;

  const maxRefs = normalizeMaxRefs(rawMaxRefs);
  const safeTools = filterSafeBrowseTools(tools);
  const normalizedSessionHistory = normalizeSessionHistorySnapshot(sessionHistory);
  const observedContext: ObservedBrowseContext = { sessionHistory: normalizedSessionHistory };
  const customTools = createInternalBrowseTools(cwd, normalizedSessionHistory, observedContext);
  const activeTools = [...safeTools, ...customTools.map((tool) => tool.name)];

  throwIfAborted(signal);
  if (!cwd || activeTools.length === 0) return { refs: [] };

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

  const sessionOptions: CompatCreateAgentSessionOptions = {
    cwd,
    agentDir: getAgentDir(),
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    tools: activeTools,
    toolNames: activeTools,
    disableExtensionDiscovery: true,
    preloadedCustomToolPaths: [],
    enableMCP: false,
    customTools,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  };
  const { session } = await createAgentSession(sessionOptions);

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
    const parsed = parseBrowseResult(responseText);
    return await sanitizeBrowseResult(parsed, cwd, maxRefs, observedContext);
  } finally {
    signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}

function buildBrowseSystemPrompt(maxRefs: number): string {
  return [
    "You are a codebase browsing scout.",
    "Use only the available read-only and information tools to inspect the repository, bounded git context, and bounded current-branch conversation context when they are useful.",
    "Do not edit files, do not propose code changes, and do not solve the task.",
    "Your only job is to identify the smallest useful set of files and structured supporting context a later prompt-enhancement model should reference.",
    "",
    "Return ONLY JSON in this shape:",
    '{"refs":[{"path":"src/file.ts","score":97,"isEntrypoint":false,"reason":"Entry point for the main module","role":"implementation","symbols":["startApp","config"]}],"gitContext":{"branch":"feat/name","statusSummary":"2 modified files.","changedFiles":["src/file.ts"],"diffSummary":"Recent local changes adjust browse-pass plumbing.","changedFileDetails":[{"path":"src/file.ts","status":"modified","staged":true,"unstaged":false,"untracked":false,"additions":5,"deletions":2}]},"sessionContext":{"relevantMessages":[{"role":"user","text":"Follow up on the earlier browse-pass review."}]}}',
    `Return at most ${maxRefs} refs.`,
    `Return at most ${MAX_CHANGED_FILES} changed files and at most ${MAX_SELECTED_MESSAGES} conversation messages when those sections are useful.`,
    `Optionally include a short reason (max ${MAX_REASON_CHARS} chars), a role label (max ${MAX_ROLE_CHARS} chars), and key symbols (at most ${MAX_SYMBOLS}, each max ${MAX_SYMBOL_CHARS} chars) for each ref.`,
    "Only include gitContext or sessionContext when they materially help the later prompt rewrite.",
    "Never invent paths, branch names, diffs, or conversation messages. Only return information you actually inspected or directly inferred from inspected tool results.",
  ].join("\n");
}

function buildBrowseUserPrompt(input: string, maxRefs: number): string {
  return [
    "Task to prepare for:",
    input,
    "",
    `Browse the codebase and return at most ${maxRefs} file refs that would best ground a later prompt rewrite.`,
    "Use git_context or session_history only when they help preserve continuity for follow-up work.",
    "Prefer entry points, primary implementation files, and the smallest useful support files.",
    "For each ref, you may optionally include a short reason explaining why it matters, a role label (e.g. implementation, test, config), and key symbols defined in the file.",
  ].join("\n");
}

function createInternalBrowseTools(
  cwd: string,
  sessionHistory: BrowseSessionHistoryMessage[],
  observedContext: ObservedBrowseContext,
): Array<ReturnType<typeof defineTool>> {
  const tools = [createGitContextTool(cwd, observedContext)];
  if (sessionHistory.length > 0) {
    tools.push(createSessionHistoryTool(sessionHistory));
  }
  return tools;
}

function createGitContextTool(cwd: string, observedContext: ObservedBrowseContext) {
  return defineTool({
    name: INTERNAL_GIT_TOOL_NAME,
    label: "Git Context",
    description: "Read-only bounded git branch, status, and diff context for the current repository.",
    parameters: Type.Object({
      action: Type.Optional(Type.String()),
      staged: Type.Optional(Type.Boolean()),
      paths: Type.Optional(Type.Array(Type.String())),
      maxLines: Type.Optional(Type.Number()),
      maxBytes: Type.Optional(Type.Number()),
    }),
    async execute(
      _toolCallId: string,
      params: { action?: string; staged?: boolean; paths?: string[]; maxLines?: number; maxBytes?: number },
      signal?: AbortSignal,
    ) {
      const action = typeof params.action === "string" && params.action.trim() ? params.action.trim() : "summary";
      if (action === "diff") {
        const requestedPaths = Array.isArray(params.paths) && params.paths.length > 0;
        const normalizedPaths = normalizePathList(params.paths);
        const result = requestedPaths && !normalizedPaths
          ? { scope: params.staged === true ? "staged" as const : "working_tree" as const, diff: "", truncated: false, paths: [] }
          : await getGitDiff(cwd, {
            staged: params.staged === true,
            paths: normalizedPaths,
            maxLines: normalizeBoundedNumber(params.maxLines, DEFAULT_GIT_DIFF_LINES, MAX_GIT_DIFF_LINES),
            maxBytes: normalizeBoundedNumber(params.maxBytes, DEFAULT_GIT_DIFF_BYTES, MAX_GIT_DIFF_BYTES),
          }, signal);
        const details: GitToolDetails = {
          kind: "diff",
          scope: result.scope,
          diff: result.diff,
          truncated: result.truncated,
          paths: result.paths,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details,
        };
      }

      const result = await getGitSummary(cwd, signal);
      observedContext.gitSummary = result;
      const details: GitToolDetails = {
        kind: "summary",
        branch: result.branch,
        statusSummary: result.statusSummary,
        changedFiles: result.changedFiles,
        diffSummary: result.diffSummary,
        changedFileDetails: result.changedFileDetails,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details,
      };
    },
  });
}

function createSessionHistoryTool(sessionHistory: BrowseSessionHistoryMessage[]) {
  return defineTool({
    name: INTERNAL_SESSION_HISTORY_TOOL_NAME,
    label: "Session History",
    description: "Read-only bounded current-branch user and assistant conversation history for follow-up context.",
    parameters: Type.Object({
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
      role: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      latestFirst: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      const offset = Math.max(0, Math.floor(typeof params.offset === "number" && Number.isFinite(params.offset) ? params.offset : 0));
      const limit = normalizeBoundedNumber(params.limit, DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE);
      const role = params.role === "user" || params.role === "assistant" ? params.role : undefined;
      const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
      const latestFirst = params.latestFirst === true;

      let filtered = sessionHistory.map((message, index) => ({ index, ...message }));
      if (role) {
        filtered = filtered.filter((message) => message.role === role);
      }
      if (query) {
        filtered = filtered.filter((message) => message.text.toLowerCase().includes(query));
      }
      if (latestFirst) {
        filtered = [...filtered].reverse();
      }

      const total = filtered.length;
      const messages = filtered.slice(offset, offset + limit);
      const result = {
        messages,
        page: {
          offset,
          limit,
          returned: messages.length,
          total,
          hasMore: offset + messages.length < total,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}

async function getGitSummary(cwd: string, signal?: AbortSignal): Promise<GitSummaryPayload> {
  const repo = await resolveGitRepository(cwd, signal);
  if (!repo) {
    return {
      statusSummary: "Git context unavailable.",
      changedFiles: [],
    };
  }

  const branch = await resolveGitBranch(cwd, signal);
  const status = await runGit(["status", "--porcelain=v1"], cwd, signal);
  const diffStat = await runGit(["diff", "--stat", "--compact-summary"], cwd, signal);
  const stagedDiffStat = await runGit(["diff", "--cached", "--stat", "--compact-summary"], cwd, signal);
  const numstat = await runGit(["diff", "--numstat"], cwd, signal);
  const stagedNumstat = await runGit(["diff", "--cached", "--numstat"], cwd, signal);

  const statusSummary = summarizeStatus(status.stdout);
  const changedFiles = collectChangedFiles(status.stdout);
  const diffSummary = summarizeDiffStats(diffStat.stdout, stagedDiffStat.stdout);
  const changedFileDetails = collectChangedFileDetails(status.stdout, numstat.stdout, stagedNumstat.stdout);

  return {
    branch,
    statusSummary,
    changedFiles,
    diffSummary,
    changedFileDetails: changedFileDetails.length > 0 ? changedFileDetails : undefined,
  };
}

async function getGitDiff(
  cwd: string,
  options: { staged: boolean; paths?: string[]; maxLines: number; maxBytes: number },
  signal?: AbortSignal,
): Promise<GitDiffPayload> {
  const args = ["diff", "--no-ext-diff"];
  if (options.staged) args.push("--cached");
  if (options.paths?.length) {
    args.push("--", ...options.paths);
  }

  const result = await runGit(args, cwd, signal, options.maxBytes * 2);
  const truncated = truncateLinesAndBytes(result.stdout.trim(), options.maxLines, options.maxBytes);

  return {
    scope: options.staged ? "staged" : "working_tree",
    diff: truncated.content,
    truncated: truncated.truncated,
    paths: options.paths?.length ? options.paths : undefined,
  };
}

async function resolveGitRepository(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd, signal);
  const stdout = result.stdout.trim();
  return stdout || undefined;
}

async function resolveGitBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const branch = (await runGit(["branch", "--show-current"], cwd, signal)).stdout.trim();
  if (branch) return branch;
  const detached = (await runGit(["rev-parse", "--short", "HEAD"], cwd, signal)).stdout.trim();
  return detached ? `detached@${detached}` : undefined;
}

async function runGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  maxBytes = GIT_COMMAND_MAX_BYTES,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (signal?.aborted) throwIfAborted(signal);

  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    let stdout = "";
    let stderr = "";
    let killedForOutputLimit = false;
    let resolved = false;

    const resolveOnce = (result: { stdout: string; stderr: string; code: number | null }) => {
      if (resolved) return;
      resolved = true;
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, GIT_COMMAND_TIMEOUT_MS);

    const appendChunk = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
      killedForOutputLimit = true;
      child.kill("SIGTERM");
      return truncateBytes(next, maxBytes);
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendChunk(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendChunk(stderr, chunk);
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).name === "AbortError") {
        reject(error);
        return;
      }
      resolveOnce({ stdout: "", stderr: error.message, code: 1 });
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      if (killedForOutputLimit) {
        stdout = truncateBytes(stdout, maxBytes);
        stderr = truncateBytes(stderr, maxBytes);
      }
      resolveOnce({ stdout, stderr, code });
    });
  });
}

function parseBrowseResult(content: string): ParsedBrowseResult {
  const parsed = parseJsonObject(content);
  return {
    refs: parseRefsFromJson(parsed),
    gitContext: parseGitContextFromJson(parsed),
    sessionContext: parseSessionContextFromJson(parsed),
  };
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

function parseRefsFromJson(parsed: unknown): ParsedRef[] {
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

    const parsedRef: ParsedRef = {
      path,
      score: clampScore((rawRef as { score?: unknown }).score),
      isEntrypoint: typeof (rawRef as { isEntrypoint?: unknown }).isEntrypoint === "boolean"
        ? (rawRef as { isEntrypoint: boolean }).isEntrypoint
        : false,
    };
    const reason = normalizeInlineText((rawRef as { reason?: unknown }).reason, MAX_REASON_CHARS) || undefined;
    if (reason) parsedRef.reason = reason;
    const role = normalizeInlineText((rawRef as { role?: unknown }).role, MAX_ROLE_CHARS) || undefined;
    if (role) parsedRef.role = role;
    const rawSymbols = normalizeStringArray((rawRef as { symbols?: unknown }).symbols, MAX_SYMBOLS, MAX_SYMBOL_CHARS);
    if (rawSymbols.length > 0) parsedRef.symbols = rawSymbols;
    refs.push(parsedRef);
  }

  return refs;
}

function parseGitContextFromJson(parsed: unknown): GitContext | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const raw = (parsed as { gitContext?: unknown }).gitContext;
  if (!raw || typeof raw !== "object") return undefined;

  const branch = normalizeInlineText((raw as { branch?: unknown }).branch, 200);
  const statusSummary = normalizeInlineText((raw as { statusSummary?: unknown }).statusSummary, MAX_GIT_SUMMARY_CHARS);
  const changedFiles = normalizeStringArray((raw as { changedFiles?: unknown }).changedFiles, MAX_CHANGED_FILES, 300);
  const diffSummary = normalizeInlineText((raw as { diffSummary?: unknown }).diffSummary, MAX_GIT_DIFF_CHARS);
  const rawChangedFileDetails = (raw as { changedFileDetails?: unknown }).changedFileDetails;
  const hasChangedFileDetails = Array.isArray(rawChangedFileDetails);

  if (!branch && !statusSummary && changedFiles.length === 0 && !diffSummary && !hasChangedFileDetails) return undefined;

  return {
    branch: branch || undefined,
    statusSummary: statusSummary || undefined,
    changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
    diffSummary: diffSummary || undefined,
  };
}

function parseSessionContextFromJson(parsed: unknown): SessionContext | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const raw = (parsed as { sessionContext?: unknown }).sessionContext;
  if (!raw || typeof raw !== "object") return undefined;

  const rawMessages = Array.isArray((raw as { relevantMessages?: unknown }).relevantMessages)
    ? (raw as { relevantMessages: unknown[] }).relevantMessages
    : [];

  const relevantMessages: SessionContextMessage[] = [];
  for (const rawMessage of rawMessages) {
    if (!rawMessage || typeof rawMessage !== "object") continue;
    const role = (rawMessage as { role?: unknown }).role;
    const text = normalizeInlineText((rawMessage as { text?: unknown }).text, MAX_SELECTED_MESSAGE_CHARS);
    if ((role !== "user" && role !== "assistant") || !text) continue;
    relevantMessages.push({ role, text });
    if (relevantMessages.length >= MAX_SELECTED_MESSAGES) break;
  }

  if (relevantMessages.length === 0) return undefined;
  return { relevantMessages };
}

async function sanitizeBrowseResult(
  parsed: ParsedBrowseResult,
  cwd: string,
  maxRefs: number,
  observedContext: ObservedBrowseContext,
): Promise<BrowseCodebaseResult> {
  return {
    refs: await sanitizeRefs(parsed.refs, cwd, maxRefs),
    gitContext: parsed.gitContext ? sanitizeObservedGitContext(observedContext.gitSummary) : undefined,
    sessionContext: validateObservedSessionContext(parsed.sessionContext, observedContext.sessionHistory),
  };
}

function sanitizeObservedGitContext(gitSummary: GitSummaryPayload | undefined): GitContext | undefined {
  if (!gitSummary) return undefined;
  const branch = normalizeInlineText(gitSummary.branch, 200);
  const statusSummary = normalizeInlineText(gitSummary.statusSummary, MAX_GIT_SUMMARY_CHARS);
  const changedFiles = normalizeStringArray(gitSummary.changedFiles, MAX_CHANGED_FILES, 300)
    .filter(isSafeRepoRelativePathCandidate);
  const diffSummary = normalizeInlineText(gitSummary.diffSummary, MAX_GIT_DIFF_CHARS);
  const changedFileDetails = sanitizeChangedFileDetails(gitSummary.changedFileDetails);

  if (!branch && !statusSummary && changedFiles.length === 0 && !diffSummary && !changedFileDetails) return undefined;

  return {
    branch: branch || undefined,
    statusSummary: statusSummary || undefined,
    changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
    diffSummary: diffSummary || undefined,
    changedFileDetails,
  };
}

function sanitizeChangedFileDetails(
  details: ChangedFileDetailPayload[] | undefined,
): ChangedFileDetail[] | undefined {
  if (!details || details.length === 0) return undefined;

  const sanitized: ChangedFileDetail[] = [];
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const path = normalizeInlineText(detail.path, 400);
    if (!path || !isSafeRepoRelativePathCandidate(path)) continue;
    const status = normalizeInlineText(detail.status, 20) || "modified";

    sanitized.push({
      path,
      status,
      staged: detail.staged === true,
      unstaged: detail.unstaged === true,
      untracked: detail.untracked === true,
      additions: normalizeOptionalCount(detail.additions),
      deletions: normalizeOptionalCount(detail.deletions),
    });

    if (sanitized.length >= MAX_CHANGED_FILES) break;
  }

  return sanitized.length > 0 ? sanitized : undefined;
}

function normalizeOptionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function validateObservedSessionContext(
  requestedContext: SessionContext | undefined,
  observedHistory: BrowseSessionHistoryMessage[],
): SessionContext | undefined {
  if (!requestedContext?.relevantMessages.length) return undefined;

  const observed = new Set(
    observedHistory.map((message) => `${message.role}\0${normalizeInlineText(message.text, MAX_SELECTED_MESSAGE_CHARS)}`),
  );
  const relevantMessages = requestedContext.relevantMessages.filter((message) => {
    return observed.has(`${message.role}\0${normalizeInlineText(message.text, MAX_SELECTED_MESSAGE_CHARS)}`);
  });

  return relevantMessages.length > 0 ? { relevantMessages } : undefined;
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
    const ref: Ref = {
      path,
      score: parsedRef.score,
      isEntrypoint: parsedRef.isEntrypoint,
    };
    if (parsedRef.reason) ref.reason = parsedRef.reason;
    if (parsedRef.role) ref.role = parsedRef.role;
    if (parsedRef.symbols?.length) ref.symbols = parsedRef.symbols;
    refs.push(ref);
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
    case INTERNAL_GIT_TOOL_NAME:
      return "Inspecting git context…";
    case INTERNAL_SESSION_HISTORY_TOOL_NAME:
      return "Reading session history…";
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
    if (!RUNTIME_SAFE_BROWSE_TOOL_NAMES.has(tool) || seen.has(tool)) continue;
    seen.add(tool);
    safeTools.push(tool);
  }

  return safeTools;
}

function normalizeMaxRefs(maxRefs: number): number {
  if (!Number.isFinite(maxRefs)) return DEFAULT_MAX_REFS;
  return Math.max(1, Math.floor(maxRefs));
}

function normalizeSessionHistorySnapshot(sessionHistory: BrowseSessionHistoryMessage[]): BrowseSessionHistoryMessage[] {
  const normalized: BrowseSessionHistoryMessage[] = [];
  let totalChars = 0;

  for (let i = sessionHistory.length - 1; i >= 0; i--) {
    const message = sessionHistory[i];
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = normalizeMultilineText(message.text, MAX_HISTORY_MESSAGE_CHARS);
    if (!text) continue;

    if (normalized.length >= MAX_HISTORY_SNAPSHOT_MESSAGES) break;
    if (totalChars + text.length > MAX_HISTORY_TOTAL_CHARS) break;

    normalized.unshift({ role: message.role, text });
    totalChars += text.length;
  }

  return normalized;
}

function normalizeInlineText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\x00/g, "")
    .replace(/[\x01-\x08]/g, "")
    .replace(/[\x0B]/g, "")
    .replace(/[\x0C]/g, "")
    .replace(/[\x0E-\x1F]/g, "")
    .replace(/[\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function normalizeMultilineText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\x00/g, "")
    .replace(/[\x01-\x08]/g, "")
    .replace(/[\x0B]/g, "")
    .replace(/[\x0C]/g, "")
    .replace(/[\x0E-\x1F]/g, "")
    .replace(/[\x7F]/g, "")
    .trim()
    .slice(0, maxChars);
}

function normalizeStringArray(value: unknown, maxItems: number, maxCharsPerItem: number): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  for (const item of value) {
    const text = normalizeInlineText(item, maxCharsPerItem);
    if (!text) continue;
    normalized.push(text);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

function normalizePathList(value: unknown): string[] | undefined {
  const paths = normalizeStringArray(value, MAX_CHANGED_FILES, 400)
    .filter(isSafeRepoRelativePathCandidate);
  return paths.length > 0 ? paths : undefined;
}

function isSafeRepoRelativePathCandidate(path: string): boolean {
  if (!path || path.includes("\0")) return false;
  if (path.startsWith(":")) return false;
  if (isAbsolute(path)) return false;
  const segments = path.split(/[\\/]+/);
  return segments.every((segment) => segment !== ".." && segment !== "");
}

function normalizeBoundedNumber(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function collectChangedFileDetails(
  porcelain: string,
  numstatOutput: string,
  stagedNumstatOutput: string,
): ChangedFileDetailPayload[] {
  const numstatMap = parseNumstat(numstatOutput);
  const stagedNumstatMap = parseNumstat(stagedNumstatOutput);
  const details: ChangedFileDetailPayload[] = [];

  for (const entry of parseStatusEntries(porcelain)) {
    let additions = 0;
    let deletions = 0;
    const unstagedStat = numstatMap.get(entry.path);
    const stagedStat = stagedNumstatMap.get(entry.path);
    if (unstagedStat) {
      additions += unstagedStat.additions;
      deletions += unstagedStat.deletions;
    }
    if (stagedStat) {
      additions += stagedStat.additions;
      deletions += stagedStat.deletions;
    }

    const detail: ChangedFileDetailPayload = {
      path: entry.path,
      status: entry.status,
      staged: entry.staged,
      unstaged: entry.unstaged,
      untracked: entry.untracked,
    };
    if (additions > 0 || deletions > 0) {
      detail.additions = additions;
      detail.deletions = deletions;
    }

    details.push(detail);
    if (details.length >= MAX_CHANGED_FILES) break;
  }

  return details;
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parseInt(parts[0], 10);
    const deletions = parseInt(parts[1], 10);
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue;
    // For renames/copies, numstat emits old_path\tnew_path (4+ parts)
    const path = parts.length >= 4 ? parts[parts.length - 1] : parts[2];
    if (!path) continue;
    // Resolve Git's compact rename format: src/{old.ts => new.ts} → src/new.ts
    const resolvedPath = parseCompactRenamePath(path) ?? path;
    const existing = map.get(resolvedPath);
    if (existing) {
      existing.additions += additions;
      existing.deletions += deletions;
    } else {
      map.set(resolvedPath, { additions, deletions });
    }
  }
  return map;
}

/**
 * Extract the new path from Git's compact rename format.
 *
 * Git sometimes outputs renames in compact curly-brace form:
 *   src/{old.ts => new.ts}  →  src/new.ts
 *   {old.ts => new.ts}      →  new.ts
 *
 * Returns the resolved new path, or null if the format is not present.
 */
function parseCompactRenamePath(path: string): string | null {
  const braceOpen = path.indexOf("{");
  if (braceOpen === -1) return null;
  const braceClose = path.indexOf("}", braceOpen + 1);
  if (braceClose === -1) return null;

  const prefix = path.slice(0, braceOpen);
  const inside = path.slice(braceOpen + 1, braceClose);
  const suffix = path.slice(braceClose + 1);

  const arrowIndex = inside.indexOf("=>");
  if (arrowIndex === -1) return null;

  const newPart = inside.slice(arrowIndex + 2).trim();
  if (!newPart) return null;

  return prefix + newPart + suffix;
}

function xyToStatus(
  x: string,
  y: string,
): { status: string; staged: boolean; unstaged: boolean; untracked: boolean } {
  if (x === "?" && y === "?") {
    return { status: "unknown", staged: false, unstaged: false, untracked: true };
  }

  let status: string;
  if (x === "M") status = "modified";
  else if (x === "A") status = "added";
  else if (x === "D") status = "deleted";
  else if (x === "R") status = "renamed";
  else if (x === "C") status = "copied";
  else if (x === "U" || y === "U") status = "unmerged";
  else if (x === "T" || y === "T") status = "modified";
  else if (y === "M") status = "modified";
  else if (y === "D") status = "deleted";
  else if (y === "A") status = "added";
  else if (x === " " && y === " ") status = "modified";
  else status = "modified";

  return {
    status,
    staged: x !== " " && x !== "?",
    unstaged: y !== " " && y !== "?",
    untracked: false,
  };
}

function summarizeStatus(porcelain: string): string {
  const { staged, unstaged, untracked } = categorizeStatusLines(porcelain);
  const parts: string[] = [];
  if (staged.length > 0) parts.push(`${staged.length} staged`);
  if (unstaged.length > 0) parts.push(`${unstaged.length} unstaged`);
  if (untracked.length > 0) parts.push(`${untracked.length} untracked`);
  return parts.length > 0 ? `${parts.join(", ")} files.` : "Working tree clean.";
}

function collectChangedFiles(porcelain: string): string[] {
  const { staged, unstaged, untracked } = categorizeStatusLines(porcelain);
  return uniqueStrings([...staged, ...unstaged, ...untracked]).slice(0, MAX_CHANGED_FILES);
}

function summarizeDiffStats(workingTreeStat: string, stagedStat: string): string | undefined {
  const parts: string[] = [];
  const working = normalizeInlineText(workingTreeStat, MAX_GIT_DIFF_CHARS);
  const staged = normalizeInlineText(stagedStat, MAX_GIT_DIFF_CHARS);
  if (working) parts.push(`unstaged: ${working}`);
  if (staged) parts.push(`staged: ${staged}`);
  const summary = parts.join(" | ");
  return summary ? summary.slice(0, MAX_GIT_DIFF_CHARS) : undefined;
}

interface StatusEntry {
  path: string;
  x: string;
  y: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

function parseStatusEntries(porcelain: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of porcelain.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const path = extractStatusPath(line.slice(3));
    if (!path || seen.has(path)) continue;
    seen.add(path);

    entries.push({ path, x, y, ...xyToStatus(x, y) });
  }

  return entries;
}

function categorizeStatusLines(porcelain: string): { staged: string[]; unstaged: string[]; untracked: string[] } {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const entry of parseStatusEntries(porcelain)) {
    if (entry.untracked) {
      untracked.push(entry.path);
      continue;
    }
    if (entry.staged) staged.push(entry.path);
    if (entry.unstaged) unstaged.push(entry.path);
  }

  return {
    staged: uniqueStrings(staged),
    unstaged: uniqueStrings(unstaged),
    untracked: uniqueStrings(untracked),
  };
}

function extractStatusPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  const renamedPath = trimmed.includes(" -> ") ? trimmed.split(" -> ").at(-1) ?? trimmed : trimmed;
  return normalizeInlineText(unquoteGitStatusPath(renamedPath), 400);
}

function unquoteGitStatusPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;

  const inner = path.slice(1, -1);
  let result = "";
  let octalBytes: number[] = [];
  const flushOctalBytes = () => {
    if (octalBytes.length === 0) return;
    result += GIT_PATH_DECODER.decode(Uint8Array.from(octalBytes));
    octalBytes = [];
  };

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!;
    if (char !== "\\") {
      flushOctalBytes();
      result += char;
      continue;
    }

    const next = inner[++i];
    if (next === undefined) break;
    if (next === "n") {
      flushOctalBytes();
      result += "\n";
    } else if (next === "r") {
      flushOctalBytes();
      result += "\r";
    } else if (next === "t") {
      flushOctalBytes();
      result += "\t";
    } else if (next === "b") {
      flushOctalBytes();
      result += "\b";
    } else if (next === "f") {
      flushOctalBytes();
      result += "\f";
    } else if (next >= "0" && next <= "7") {
      let octal = next;
      for (let j = 0; j < 2; j++) {
        const peek = inner[i + 1];
        if (peek === undefined || peek < "0" || peek > "7") break;
        octal += inner[++i]!;
      }
      octalBytes.push(parseInt(octal, 8));
    } else {
      flushOctalBytes();
      result += next;
    }
  }
  flushOctalBytes();
  return result;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let low = 0;
  let high = value.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = value.slice(0, mid);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      best = candidate;
      low = mid + 1;
      continue;
    }
    high = mid - 1;
  }

  return best;
}

function truncateLinesAndBytes(value: string, maxLines: number, maxBytes: number): { content: string; truncated: boolean } {
  const normalized = value.trim();
  if (!normalized) return { content: "", truncated: false };

  const lines = normalized.split(/\r?\n/);
  const limitedLines = lines.slice(0, maxLines);
  let content = truncateBytes(limitedLines.join("\n"), maxBytes);
  const truncated = limitedLines.length < lines.length || content.length < normalized.length;
  if (truncated) {
    content = `${content}\n\n[truncated]`.trim();
  }
  return { content, truncated };
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
