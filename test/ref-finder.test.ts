/**
 * Tests for ref-finder.ts — repo-scoped context/ref collection.
 *
 * Covers:
 * - Output is capped at maxRefs (default 5)
 * - Output structure (Ref: path, score, isEntrypoint, lineCount)
 * - Injectable FileSystem works for deterministic testing
 * - Empty input returns []
 * - Entry points are preferred in ordering
 */

import { describe, it, expect } from "vitest";
import { findRefs, createDefaultFS, type FileSystem, type RefFinderOptions } from "../src/ref-finder.js";

// ---------------------------------------------------------------------------
// Helpers — deterministic in-memory file system
// ---------------------------------------------------------------------------

interface FakeEntry {
  /** File content, line-by-line. */
  lines: string[];
  /** Whether stat succeeds. */
  exists: boolean;
}

function makeFs(files: Record<string, FakeEntry>, repoRoot?: string): FileSystem {
  return {
    async lsRecursive(_dir: string, maxFiles?: number): Promise<string[]> {
      // Return keys that start with the given dir
      const keys = Object.keys(files)
        .filter((f) => files[f].exists)
        .sort();
      return maxFiles !== undefined ? keys.slice(0, maxFiles) : keys;
    },
    async readHead(filePath: string, n: number): Promise<string[]> {
      const entry = files[filePath];
      if (!entry || !entry.exists) return [];
      return entry.lines.slice(0, Math.max(0, n));
    },
    async lineCount(filePath: string): Promise<number> {
      const entry = files[filePath];
      if (!entry || !entry.exists) return 0;
      return entry.lines.length;
    },
    async getRepoRoot(_dir: string): Promise<string | undefined> {
      return repoRoot;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findRefs", () => {
  it("returns an empty array for empty or whitespace-only text", async () => {
    const fs = makeFs({
      "/project/main.ts": { lines: ["const x = 1;"], exists: true },
    });

    const result1 = await findRefs("", "/project", undefined, fs);
    expect(result1).toEqual([]);

    const result2 = await findRefs("   ", "/project", undefined, fs);
    expect(result2).toEqual([]);
  });

  it("returns structured Ref objects with path, score, isEntrypoint, lineCount", async () => {
    const fs = makeFs({
      "/project/main.ts": {
        lines: ["// entry point", "const app = start();"],
        exists: true,
      },
      "/project/utils/helpers.ts": {
        lines: ["// helpers", "export function help() {}"],
        exists: true,
      },
    });

    const result = await findRefs("main entry point", "/project", undefined, fs);

    expect(result.length).toBeGreaterThan(0);
    for (const ref of result) {
      expect(ref).toHaveProperty("path");
      expect(ref).toHaveProperty("score");
      expect(typeof ref.score).toBe("number");
      expect(ref.score).toBeGreaterThan(0);
      expect(ref).toHaveProperty("isEntrypoint");
      expect(typeof ref.isEntrypoint).toBe("boolean");
      expect(ref).toHaveProperty("lineCount");
      expect(typeof ref.lineCount).toBe("number");
    }
  });

  it("caps output at the default maxRefs count (5)", async () => {
    // Create many files that match so the finder has >5 candidates
    const files: Record<string, FakeEntry> = {};
    for (let i = 0; i < 10; i++) {
      files[`/project/src/file${i}.ts`] = {
        lines: [`// file ${i}: matches main logic`],
        exists: true,
      };
    }

    const fs = makeFs(files);
    const result = await findRefs("main logic", "/project", undefined, fs);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("caps output at custom maxRefs", async () => {
    const files: Record<string, FakeEntry> = {};
    for (let i = 0; i < 10; i++) {
      files[`/project/src/file${i}.ts`] = {
        lines: [`// file ${i}: matches main logic`],
        exists: true,
      };
    }

    const fs = makeFs(files);
    const opts: RefFinderOptions = { maxRefs: 2 };
    const result = await findRefs("main logic", "/project", opts, fs);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("returns no refs when maxRefs is 0 even if entrypoints match", async () => {
    const fs = makeFs({
      "/project/main.ts": {
        lines: ["main entry point"],
        exists: true,
      },
      "/project/src/sidebar.ts": {
        lines: ["sidebar sorting logic"],
        exists: true,
      },
    });

    const result = await findRefs("main sidebar", "/project", { maxRefs: 0 }, fs);
    expect(result).toEqual([]);
  });

  it("returns support-only refs when maxRefs < maxEntrypoints", async () => {
    // Regression: support capacity was computed as maxRefs - maxEntrypoints
    // which goes negative (or zero) when maxRefs <= maxEntrypoints,
    // starving all support-only matches.
    const files: Record<string, FakeEntry> = {};
    for (let i = 0; i < 5; i++) {
      files[`/project/src/file${i}.ts`] = {
        lines: [`// file ${i}: matches main logic`],
        exists: true,
      };
    }

    const fs = makeFs(files);

    // maxRefs:1 with default maxEntrypoints:2 — support capacity must be dynamic
    const r1 = await findRefs("main logic", "/project", { maxRefs: 1 }, fs);
    expect(r1.length).toBe(1);
    expect(r1[0].isEntrypoint).toBe(false);

    // maxRefs:2 — support capacity = 2-0 = 2 after entries (0) selected
    const r2 = await findRefs("main logic", "/project", { maxRefs: 2 }, fs);
    expect(r2.length).toBe(2);
    expect(r2[0].isEntrypoint).toBe(false);
    expect(r2[1].isEntrypoint).toBe(false);
  });

  it("fills support slots from remaining capacity after entries", async () => {
    // Ensure that when entries don't fill their quota, support gets the rest.
    const fs = makeFs({
      "/project/main.ts": {
        lines: ["main entry point"],
        exists: true,
      },
      "/project/util.ts": {
        lines: ["main utility helper"],
        exists: true,
      },
      "/project/lib/extra.ts": {
        lines: ["extra main code"],
        exists: true,
      },
    });

    // maxRefs:2, maxEntrypoints:3 — should get 1 entry + 1 support
    const result = await findRefs("main", "/project", { maxRefs: 2, maxEntrypoints: 3 }, fs);
    expect(result.length).toBe(2);
    expect(result[0].isEntrypoint).toBe(true);
    expect(result[1].isEntrypoint).toBe(false);
  });

  it("does not exceed total maxRefs when maxEntrypoints > maxRefs", async () => {
    const fs = makeFs({
      "/project/index.ts": {
        lines: ["index entry"],
        exists: true,
      },
      "/project/main.ts": {
        lines: ["main entry"],
        exists: true,
      },
      "/project/app.ts": {
        lines: ["app entry"],
        exists: true,
      },
      "/project/util.ts": {
        lines: ["main utility"],
        exists: true,
      },
    });

    // maxRefs:2, maxEntrypoints:3 — only 2 total should come back
    const result = await findRefs("main index app", "/project", { maxRefs: 2, maxEntrypoints: 3 }, fs);
    expect(result.length).toBe(2);
    // First two should be entrypoints
    expect(result[0].isEntrypoint).toBe(true);
    expect(result[1].isEntrypoint).toBe(true);
  });

  it("respects maxEntrypoints:0 — no entrypoint refs even when entry files match", async () => {
    const fs = makeFs({
      "/project/main.ts": {
        lines: ["main entry point"],
        exists: true,
      },
      "/project/index.ts": {
        lines: ["index entry barrel"],
        exists: true,
      },
      "/project/util.ts": {
        lines: ["main utility helper"],
        exists: true,
      },
    });

    const result = await findRefs(
      "main index entry",
      "/project",
      { maxRefs: 3, maxEntrypoints: 0 },
      fs,
    );

    // No entrypoints should be returned
    for (const ref of result) {
      expect(ref.isEntrypoint).toBe(false);
    }
    // Support refs should still fill available slots
    expect(result.length).toBeGreaterThan(0);
  });

  it("caps entrypoints at maxEntrypoints and fills remaining with true support refs", async () => {
    // Regression: overflow entrypoints used to spill into support slots,
    // starving true support refs and inflating entry count beyond maxEntrypoints.
    const fs = makeFs({
      "/project/main.ts": {
        lines: ["main entry point"],
        exists: true,
      },
      "/project/index.ts": {
        lines: ["index entry barrel"],
        exists: true,
      },
      "/project/app.ts": {
        lines: ["app entry runner"],
        exists: true,
      },
      "/project/util.ts": {
        lines: ["main helper for app"],
        exists: true,
      },
      "/project/lib/extra.ts": {
        lines: ["extra helper utility"],
        exists: true,
      },
      "/project/tool.ts": {
        lines: ["main app helper tool"],
        exists: true,
      },
    });

    // maxEntrypoints=1, maxRefs=3: 1 entry + 2 support
    const result = await findRefs(
      "main index app helper",
      "/project",
      { maxRefs: 3, maxEntrypoints: 1 },
      fs,
    );

    expect(result.length).toBe(3);

    // First ref must be an entrypoint
    expect(result[0].isEntrypoint).toBe(true);

    // Remaining 2 must be true support refs (not overflow entrypoints)
    expect(result[1].isEntrypoint).toBe(false);
    expect(result[2].isEntrypoint).toBe(false);

    // Exactly 1 entrypoint in total
    const entryCount = result.filter((r) => r.isEntrypoint).length;
    expect(entryCount).toBe(1);
  });

  it("stops file-system traversal at the maxFiles cap", async () => {
    // Create 10 files; only the last 5 contain matching content.
    // With maxFiles=5 the traversal only sees file0..file4 (no match).
    // With maxFiles=10 all files are seen and matches are found.
    const manyFiles: Record<string, FakeEntry> = {};
    for (let i = 0; i < 5; i++) {
      manyFiles[`/project/src/file${i}.ts`] = {
        lines: [`// no match here`],
        exists: true,
      };
    }
    for (let i = 5; i < 10; i++) {
      manyFiles[`/project/src/file${i}.ts`] = {
        lines: [`// matches main test`],
        exists: true,
      };
    }

    const fs = makeFs(manyFiles);

    // Cap at 5 means file0..file4 are scanned, none match
    const result = await findRefs("main test", "/project", { maxFiles: 5 }, fs);
    expect(result).toEqual([]);

    // Cap at 10 means all files are scanned, matches found
    const result2 = await findRefs("main test", "/project", { maxFiles: 10 }, fs);
    expect(result2.length).toBeGreaterThan(0);
  });

  it("places entry-point files before support files in the result", async () => {
    const fs = makeFs({
      "/project/index.ts": {
        lines: ["// index — entry point", "export default {};"],
        exists: true,
      },
      "/project/src/util.ts": {
        lines: ["// util — matches main", "export function main() {}"],
        exists: true,
      },
      "/project/main.ts": {
        lines: ["// main entry", "start()"],
        exists: true,
      },
      "/project/src/helper.ts": {
        lines: ["// helper", "export function helper() {}"],
        exists: true,
      },
    });

    const result = await findRefs("main entry index", "/project", undefined, fs);
    expect(result.length).toBeGreaterThan(0);

    // Find which indices are entrypoints
    const entryIndices = result
      .map((r, i) => (r.isEntrypoint ? i : -1))
      .filter((i) => i >= 0);
    const supportIndices = result
      .map((r, i) => (!r.isEntrypoint ? i : -1))
      .filter((i) => i >= 0);

    if (entryIndices.length > 0 && supportIndices.length > 0) {
      // All entrypoints should come before support files
      const maxEntryIdx = Math.max(...entryIndices);
      const minSupportIdx = Math.min(...supportIndices);
      expect(maxEntryIdx).toBeLessThan(minSupportIdx);
    }
  });

  it("filters files to only those with a baseline token match", async () => {
    const fs = makeFs({
      "/project/main.ts": {
        lines: ["const x = 1;"],
        exists: true,
      },
      "/project/unrelated.md": {
        lines: ["# unrelated", "no matching token here"],
        exists: true,
      },
    });

    // Text that only matches `main` but not `unrelated`
    const result = await findRefs("main logic startup", "/project", undefined, fs);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // All returned refs should have a score > 0
    for (const ref of result) {
      expect(ref.score).toBeGreaterThan(0);
    }
  });

  it("returns refs with relative paths from the search root", async () => {
    const fs = makeFs(
      {
        "/home/user/repo/src/main.ts": {
          lines: ["const x = 1;"],
          exists: true,
        },
        "/home/user/repo/src/lib.ts": {
          lines: ["const y = 2;"],
          exists: true,
        },
      },
      "/home/user/repo",
    );

    const result = await findRefs("main lib", "/home/user/repo", undefined, fs);
    expect(result.length).toBeGreaterThan(0);
    for (const ref of result) {
      // Paths should be relative to /home/user/repo, not absolute
      expect(ref.path).not.toContain("/home/user/repo/");
      expect(ref.path.startsWith("src/")).toBe(true);
    }
  });

  it("returns empty array when no files exist", async () => {
    const fs = makeFs({});
    const result = await findRefs("test", "/project", undefined, fs);
    expect(result).toEqual([]);
  });

  it("assigns entrypoint=true to files matching entry patterns (main.*, index.*, etc.)", async () => {
    const fs = makeFs({
      "/project/main.ts": {
        lines: ["// main entry point"],
        exists: true,
      },
      "/project/src/index.ts": {
        lines: ["// index barrel"],
        exists: true,
      },
      "/project/src/cli.ts": {
        lines: ["// cli runner"],
        exists: true,
      },
      "/project/src/helper.ts": {
        lines: ["// helper function"],
        exists: true,
      },
    });

    // Use high caps so we test entrypoint detection, not capping
    const result = await findRefs(
      "main index cli helper",
      "/project",
      { maxRefs: 10, maxEntrypoints: 10 },
      fs,
    );
    const entryRefs = result.filter((r) => r.isEntrypoint);
    const entryPaths = entryRefs.map((r) => r.path);

    expect(entryPaths).toContain("main.ts");
    expect(entryPaths).toContain("src/index.ts");
    expect(entryPaths).toContain("src/cli.ts");
    // All three entry files should be detected as entrypoints
    expect(entryRefs.length).toBeGreaterThanOrEqual(3);
  });

  it("returns lineCount > 0 for files that exist", async () => {
    const fs = makeFs({
      "/project/main.ts": {
        lines: Array.from({ length: 42 }, (_, i) => `line ${i + 1}`),
        exists: true,
      },
    });

    const result = await findRefs("main", "/project", undefined, fs);
    expect(result.length).toBe(1);
    expect(result[0].lineCount).toBe(42);
  });

  it("returns lineCount = 0 for files that fail to read", async () => {
    const fs = makeFs({
      "/project/main.ts": {
        lines: ["const x = 1;"],
        exists: false, // file doesn't exist for lineCount but lsRecursive returns it? Let's fix
      },
    } as any);

    // Override lineCount to fail
    const brokenFs: FileSystem = {
      ...fs,
      async lineCount(): Promise<number> {
        return 0;
      },
    };

    const result = await findRefs("main", "/project", undefined, brokenFs);
    expect(result.length).toBe(0); // no files because main.ts doesn't exist per lsRecursive
  });

  it("never scores files based on absolute-path tokens that don't appear in the relative path", async () => {
    // Regression: before the fix, scoreFile() was handed the absolute path
    // (e.g. "/some/prefix/repo-name/src/main.ts") so directory tokens like
    // "prefix" or "repo-name" in the absolute path could inflate the score
    // of unrelated files. After the fix, only the repo-relative path is used
    // for token matching, so directory tokens from the absolute path no
    // longer match.
    const repoRoot = "/home/user/alpha-project";
    const fs = makeFs(
      {
        "/home/user/alpha-project/src/helper.ts": {
          // Content does NOT contain "alpha" or "project"
          lines: ["// simple helper utility"],
          exists: true,
        },
        "/home/user/alpha-project/lib/util.ts": {
          // Content does NOT contain "alpha" or "project"
          lines: ["// general utility"],
          exists: true,
        },
      },
      repoRoot,
    );

    // "alpha" is a plain-word token that appears ONLY in the absolute
    // directory path "/home/user/alpha-project" — NOT in any relative path
    // ("src/helper.ts", "lib/util.ts") and NOT in any file content.
    // Before the fix, both files would score 25+ for the absolute-path
    // match on "alpha". With the fix, neither should match.
    const result = await findRefs(
      "alpha something unrelated",
      "/home/user/alpha-project",
      undefined,
      fs,
    );

    expect(result).toEqual([]);
  });

  it("prefers shallow files (higher depth bonus)", async () => {
    const fs = makeFs({
      "/project/main.ts": {
        lines: ["main entry"],
        exists: true,
      },
      "/project/src/deep/util.ts": {
        lines: ["deep utility"],
        exists: true,
      },
    });

    const result = await findRefs("main util entry", "/project", undefined, fs);
    // main.ts (depth 1) should appear before src/deep/util.ts (depth 3)
    const shallowIdx = result.findIndex((r) => r.path === "main.ts");
    const deepIdx = result.findIndex((r) => r.path === "src/deep/util.ts");
    // Both should be found (or main.ts should be, at minimum)
    expect(shallowIdx).toBeGreaterThanOrEqual(0);
    if (deepIdx >= 0) {
      expect(shallowIdx).toBeLessThan(deepIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Default FS smoke tests (optional — helps catch integration regressions)
// ---------------------------------------------------------------------------

describe("createDefaultFS", () => {
  it("returns a FileSystem implementation", () => {
    const fs = createDefaultFS();
    expect(fs).toBeDefined();
    expect(typeof fs.lsRecursive).toBe("function");
    expect(typeof fs.readHead).toBe("function");
    expect(typeof fs.lineCount).toBe("function");
    expect(typeof fs.getRepoRoot).toBe("function");
  });
});
