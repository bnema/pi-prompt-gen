/**
 * ref-finder.ts — repo-scoped context/ref collection for pi-prompt-gen.
 *
 * Given user text and a cwd, returns a small ranked set of relevant file
 * references (one entry point + up to 4 supporting refs) to attach as
 * grounded context for prompt enhancement.
 *
 * Design principles:
 * - Injectable FileSystem for testability (no hard-coded extension state).
 * - Search stays inside the repo root when available, otherwise the cwd.
 * - Lightweight content peeking (first N lines), not full greps.
 * - Aggressively capped output — no giant dumps.
 * - All scoring is heuristic; relevance is approximate but good enough.
 */

import fs from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single structured reference to a project file. */
export interface Ref {
  /** Relative path from the repo root (or cwd as fallback). */
  path: string;
  /** Relevance score 0–100. Higher = more likely useful for the prompt. */
  score: number;
  /** Whether this file looks like an entry point (main, index, cli, cmd, …). */
  isEntrypoint: boolean;
  /** Total line count (0 if unobtainable). */
  lineCount: number;
}

/** Configuration for the ref-finder. */
export interface RefFinderOptions {
  /** Maximum total refs returned (default 5). */
  maxRefs?: number;
  /** Maximum entry-point refs in the result (default 2). */
  maxEntrypoints?: number;
  /** Max files to scan before stopping (default 500). */
  maxFiles?: number;
  /** Lines peeped per file for lightweight content scanning (default 5). */
  contentScanLines?: number;
}

/**
 * Injectable filesystem abstraction.
 *
 * Swapping this out in tests avoids touching real disks and lets callers
 * control the file tree, repo detection, and content seen by the scorer.
 */
export interface FileSystem {
  /**
   * Recursively list all files under a directory (ignores common junk dirs).
   * @param maxFiles Optional cap; traversal stops once this many files are collected.
   */
  lsRecursive(dir: string, maxFiles?: number): Promise<string[]>;
  /** Read the first N lines of a file. */
  readHead(filePath: string, n: number): Promise<string[]>;
  /** Return the line count of a file (0 if unobtainable). */
  lineCount(filePath: string): Promise<number>;
  /** Get the git repo root for a directory. Returns undefined if not a repo. */
  getRepoRoot(dir: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Default file-system (production)
// ---------------------------------------------------------------------------

/** Directories skipped during recursive listing. */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  ".svelte-kit",
  ".turbo",
  "coverage",
  ".nyc_output",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".serverless",
  ".webpack",
  ".idea",
  ".vscode",
]);

export function createDefaultFS(): FileSystem {
  return {
    async lsRecursive(dir: string, maxFiles?: number): Promise<string[]> {
      const results: string[] = [];
      const queue = [dir];
      // Hard guard at 10k even if caller asks for more; caller's cap if lower
      const max = maxFiles !== undefined ? Math.min(maxFiles, 10_000) : 10_000;
      while (queue.length > 0 && results.length < max) {
        const currentDir = queue.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(currentDir, {
            withFileTypes: true,
          });
        } catch {
          continue; // skip unreadable dirs (permissions, broken symlinks, …)
        }
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
              queue.push(fullPath);
            }
          } else if (entry.isFile()) {
            results.push(fullPath);
            if (results.length >= max) break;
          }
        }
      }
      return results;
    },

    async readHead(filePath: string, n: number): Promise<string[]> {
      if (n <= 0) return [];
      const lines: string[] = [];
      const stream = fs.createReadStream(filePath, { encoding: "utf8" });
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          lines.push(line);
          if (lines.length >= n) {
            reader.close();
            break;
          }
        }
      } catch {
        return [];
      } finally {
        stream.destroy();
      }
      return lines;
    },

    async lineCount(filePath: string): Promise<number> {
      try {
        const content = await fs.promises.readFile(filePath, "utf8");
        return content.split("\n").length;
      } catch {
        return 0;
      }
    },

    async getRepoRoot(dir: string): Promise<string | undefined> {
      let current = path.resolve(dir);
      const root = path.parse(current).root;
      while (true) {
        try {
          const gitPath = path.join(current, ".git");
          const s = await fs.promises.stat(gitPath);
          if (s.isDirectory() || s.isFile()) return current;
        } catch {
          // not a git repo/worktree marker at this level, climb up
        }
        if (current === root) break;
        current = path.dirname(current);
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Token extraction from user text
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "this", "that", "these", "those", "it", "its", "and", "or", "but",
  "not", "no", "nor", "so", "if", "then", "else", "when", "where",
  "why", "how", "what", "which", "who", "whom", "get", "make", "let",
  "set", "run", "like", "just", "about", "also", "very", "too",
  "want", "need", "use", "using", "used", "create", "add", "fix",
  "change", "update", "remove", "help", "please", "thanks",
  "thank", "write", "implement", "new", "all", "any", "some",
  "each", "every", "both", "few", "more", "most", "much",
]);

/**
 * Extract a compact set of search tokens from free-form user text.
 *
 * Produces path fragments, code identifiers (camelCase, PascalCase,
 * snake_case, dotted), and plain words.  Stop words, very short tokens
 * and exact duplicates are stripped.  Result is capped at 20 tokens
 * to avoid query bloat.
 */
function extractTokens(text: string): string[] {
  const seen = new Set<string>();
  const collect = (w: string) => {
    const t = w.toLowerCase();
    if (t.length >= 2 && !STOP_WORDS.has(t) && !seen.has(t)) seen.add(t);
  };

  // 1. Path-like fragments (contain "/" or "\")
  for (const m of text.matchAll(/[\w.\-+@~]+[/\\][\w.\-+@/\\]+/g)) {
    for (const part of m[0].replace(/\\/g, "/").split("/")) {
      collect(part);
    }
  }

  // 2. Identifiers: camelCase, PascalCase, snake_case, dotted
  for (const m of text.matchAll(/[a-z]+[A-Z][a-zA-Z]*|[A-Z][a-z]+[A-Z][a-zA-Z]*|[a-zA-Z]+_[a-zA-Z_]+|[a-zA-Z]+\.[a-zA-Z]+/g)) {
    collect(m[0]);
  }

  // 3. Plain words (3+ chars, alpha-numeric start)
  for (const m of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9]{2,}\b/g)) {
    collect(m[0]);
  }

  return [...seen].slice(0, 20);
}

// ---------------------------------------------------------------------------
// Entry-point heuristics
// ---------------------------------------------------------------------------

const ENTRYPOINT_PATTERNS = [
  /^main\./i,
  /^index\./i,
  /^cli\./i,
  /^app\./i,
  /^server\./i,
  /^lib\./i,
  /^entry/i,
  /^mod\.(ts|js|tsx|jsx|py|rs)$/i,
  /^__init__\.py$/i,
];

function isEntrypoint(fileRel: string): boolean {
  const base = path.basename(fileRel);
  const normalized = fileRel.replace(/\\/g, "/");

  // Directory-based entry points
  for (const seg of normalized.split("/")) {
    if (seg === "cmd" || seg === "bin" || seg === "cli") return true;
  }

  // Filename patterns
  for (const p of ENTRYPOINT_PATTERNS) {
    if (p.test(base)) return true;
  }
  return false;
}

/** Recognised source-code extensions (bonus for scoring). */
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".go", ".rs", ".py", ".rb", ".java", ".kt",
  ".swift", ".zig", ".odin", ".c", ".cpp", ".h", ".hpp",
  ".svelte", ".vue", ".astro",
]);

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreFile(
  fileRel: string,
  tokens: string[],
  contentHits: Set<string>,
  pathDepth: number,
): number {
  const base = path.basename(fileRel);
  const stem = path.parse(base).name.toLowerCase();
  const rel = fileRel.replace(/\\/g, "/").toLowerCase();
  let hasBaseline = false;
  let score = 0;

  // Token match in file stem (strong signal)
  // Baseline: a token must match the filename stem or the full path.
  for (const t of tokens) {
    if (stem.includes(t) || rel.includes(t)) {
      score += 25;
      hasBaseline = true;
      break;
    }
  }

  // Token match in parent directory name
  const dirPath = path.dirname(fileRel).replace(/\\/g, "/").toLowerCase();
  for (const t of tokens) {
    if (dirPath.includes(t)) {
      score += 10;
      hasBaseline = true;
      break;
    }
  }

  // Content-match also counts as a baseline signal
  if (contentHits.has(fileRel)) {
    score += 15;
    hasBaseline = true;
  }

  // Without any baseline signal the file is irrelevant — return zero.
  if (!hasBaseline) return 0;

  // Entry-point bonus (only amplifies existing relevance)
  if (isEntrypoint(fileRel)) score += 30;

  // Depth bonus: shallow files are more likely entry/reference points
  if (pathDepth <= 2) score += 10;
  else if (pathDepth <= 3) score += 5;

  // Source-code extension bonus
  const ext = path.extname(fileRel).toLowerCase();
  if (SOURCE_EXTS.has(ext)) score += 8;
  else if (ext === ".md" || ext === ".json") score += 3;

  return Math.min(score, 100);
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

const DEFAULT_OPTS: Required<RefFinderOptions> = {
  maxRefs: 5,
  maxEntrypoints: 2,
  maxFiles: 500,
  contentScanLines: 5,
};

const CONTENT_SCAN_CONCURRENCY = 16;

async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextIndex < items.length) {
        const current = items[nextIndex++]!;
        await worker(current);
      }
    }),
  );
}

/**
 * Find relevant file references in the given working directory for the
 * provided user text.
 *
 * @param text - Raw user prompt / idea text from which search tokens
 *               are derived.
 * @param cwd  - Current working directory (used to resolve repo root).
 * @param opts - Optional configuration overrides.
 * @param fs   - Injectable filesystem (defaults to production `node:fs`
 *               implementation via `createDefaultFS()`).
 * @returns A ranked, capped array of file refs sorted by score
 *          (entrypoints first, then supporting).
 */
export async function findRefs(
  text: string,
  cwd: string,
  opts?: RefFinderOptions,
  fs?: FileSystem,
): Promise<Ref[]> {
  if (!text || !text.trim()) return [];

  const cfg: Required<RefFinderOptions> = { ...DEFAULT_OPTS, ...opts };
  cfg.maxRefs = Math.max(0, cfg.maxRefs);
  cfg.maxEntrypoints = Math.max(0, Math.min(cfg.maxEntrypoints, cfg.maxRefs));
  if (cfg.maxRefs === 0) return [];

  const ffs = fs ?? createDefaultFS();

  // Resolve the search root (repo root or cwd).
  const repoRoot = await ffs.getRepoRoot(cwd);
  const searchDir = repoRoot ?? cwd;

  // 1. List files — cap passed to traversal so fs can stop early.
  const files = await ffs.lsRecursive(searchDir, cfg.maxFiles);
  if (files.length === 0) return [];

  // 2. Extract tokens from user text.
  const tokens = extractTokens(text);
  if (tokens.length === 0) return [];

  // 3. Lightweight content scanning (first N lines of each file).
  // Store relative paths so scoring/entrypoint detection uses only
  // repo-relative paths — never absolute paths.
  const contentHits = new Set<string>();
  await forEachWithConcurrency(files, CONTENT_SCAN_CONCURRENCY, async (file) => {
    const rel = path.relative(searchDir, file).replace(/\\/g, "/");
    const head = await ffs.readHead(file, cfg.contentScanLines);
    for (const line of head) {
      const lower = line.toLowerCase();
      for (const token of tokens) {
        if (lower.includes(token)) {
          contentHits.add(rel);
          return; // one hit per file is enough
        }
      }
    }
  });

  // 4. Score and rank.
  // Use repo-relative paths everywhere: scoring, entrypoint detection, and
  // content-hit look-up. Absolute paths are never passed to these functions,
  // preventing directory- or home-path tokens from inflating relevance.
  interface Scored {
    file: string;
    score: number;
    isEntry: boolean;
  }

  const scored: Scored[] = [];
  for (const file of files) {
    const rel = path.relative(searchDir, file).replace(/\\/g, "/");
    const depth = rel === "" ? 0 : rel.split("/").length;
    const s = scoreFile(rel, tokens, contentHits, depth);
    if (s > 0) scored.push({ file, score: s, isEntry: isEntrypoint(rel) });
  }

  scored.sort((a, b) => {
    // Entrypoints first, then by score descending
    if (a.isEntry !== b.isEntry) return a.isEntry ? -1 : 1;
    return b.score - a.score;
  });

  // 5. Aggressive capping.
  const entries: Scored[] = [];
  const support: Scored[] = [];
  for (const item of scored) {
    if (item.isEntry && entries.length < cfg.maxEntrypoints) {
      entries.push(item);
    } else if (!item.isEntry && support.length < cfg.maxRefs - entries.length) {
      // Support refs fill remaining capacity.
      support.push(item);
    }
    // Overflow entrypoints are dropped (not spilled into support).
    if (entries.length + support.length >= cfg.maxRefs) break;
  }

  // 6. Build structured refs.
  const refs: Ref[] = [];
  for (const item of [...entries, ...support]) {
    const relative = path.relative(searchDir, item.file).replace(/\\/g, "/");
    const lines = await ffs.lineCount(item.file);
    refs.push({
      path: relative,
      score: item.score,
      isEntrypoint: item.isEntry,
      lineCount: lines,
    });
  }
  return refs;
}
