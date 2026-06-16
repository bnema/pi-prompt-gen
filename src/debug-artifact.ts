/**
 * Metadata artifact builder for pi-prompt-gen.
 *
 * Produces a plain-text metadata report from an EnhancePromptResult that is
 * useful for eval/debugging. It intentionally excludes the enhanced prompt
 * body, raw user input, system prompt, and full model result because those
 * may contain sensitive project data, secrets, API keys, or raw user input
 * echoed by the model.
 *
 * The artifact contains only bounded metadata, context flags, and ref paths.
 * All string metadata fields are sanitized before display: control characters
 * (newlines, tabs, escapes) are stripped, whitespace is collapsed, and
 * lengths are bounded.
 *
 * The artifact is designed for clipboard copy or file dump — not for
 * programmatic consumption.
 */

import type { EnhancePromptResult, RunMetadata } from "./index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters for a single ref path in the report. */
const MAX_REF_PATH_CHARS = 120;

/** Maximum number of refs to list in the report. */
const MAX_REFS_IN_REPORT = 10;

/** Maximum visible length for a single metadata display field. */
const MAX_DISPLAY_FIELD_CHARS = 200;

/** Maximum number of items in a display list (e.g. browseToolsUsed). */
const MAX_DISPLAY_LIST_ITEMS = 20;

// ---------------------------------------------------------------------------
// Sanitization helpers (shared across artifact and UI display)
// ---------------------------------------------------------------------------

/**
 * Sanitize a single metadata field for bounded display or notification output.
 *
 * Strips control characters (including newlines, tabs), redacts common
 * API-key shaped tokens, collapses runs of whitespace, trims, and bounds the
 * result length. This prevents caller/provider-controlled strings from
 * forging artifact lines, injecting newlines into notifications, or producing
 * unbounded display output.
 */
export function sanitizeDisplayField(value: string, maxLen = MAX_DISPLAY_FIELD_CHARS): string {
  // Replace control characters (< 32, excluding printable space at 32) and DEL (127)
  let cleaned = value.replace(/[\x00-\x1f\x7f]/g, " ");
  // Redact common API-key shaped tokens. This is best-effort hygiene for
  // display fields, not a general secret scanner.
  cleaned = cleaned.replace(/\b(?:sk|pk)-(?:test-)?[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  // Collapse runs of whitespace (including space-replaced controls) into single space
  cleaned = cleaned.replace(/\s+/g, " ");
  cleaned = cleaned.trim();
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen).trimEnd();
  }
  return cleaned;
}

/**
 * Sanitize a list of display strings for bounded artifact/notification output.
 * Each item is individually sanitized, and the list is bounded in length.
 */
export function sanitizeDisplayList(items: string[], maxItems = MAX_DISPLAY_LIST_ITEMS): string[] {
  const result: string[] = [];
  for (const item of items) {
    const cleaned = sanitizeDisplayField(item);
    if (cleaned) result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

/** Build compact, sanitized metadata summary segments for UI notifications. */
export function buildMetadataSummaryParts(md: RunMetadata): string[] {
  const parts: string[] = [];

  const modelLabel = md.modelName ? sanitizeDisplayField(md.modelName) : "";
  const fallbackModelLabel = md.modelId ? sanitizeDisplayField(md.modelId) : "";
  if (modelLabel || fallbackModelLabel) {
    parts.push(modelLabel || fallbackModelLabel);
  }
  if (md.stopReason) {
    const stopReason = sanitizeDisplayField(md.stopReason);
    if (stopReason) parts.push(stopReason);
  }
  if (md.usageSummary) {
    const u = md.usageSummary;
    const tokenParts: string[] = [];
    if (u.totalTokens !== undefined) {
      tokenParts.push(`${u.totalTokens}`);
    } else if (u.input !== undefined || u.output !== undefined) {
      if (u.input !== undefined) tokenParts.push(`${u.input}`);
      if (u.output !== undefined) tokenParts.push(`${u.output}`);
    }
    if (tokenParts.length > 0) {
      parts.push(tokenParts.join("+") + " tok");
    }
  }
  if (md.latencyMs !== undefined) {
    const sec = (md.latencyMs / 1000).toFixed(1);
    parts.push(`${sec}s`);
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a metadata debug artifact from an EnhancePromptResult.
 *
 * The returned string contains only bounded metadata, context flags, and ref
 * paths. All string metadata fields are sanitized through
 * `sanitizeDisplayField` / `sanitizeDisplayList` before emission.
 *
 * It intentionally excludes the enhanced prompt body, raw user input, system
 * prompt, and full model result because those may contain sensitive project
 * data, secrets, API keys, or raw user input echoed by the model.
 *
 * Contains:
 *   - Run metadata (model, latency, stop reason, token counts)
 *   - Ref path list (scores and symbols excluded)
 *   - Context flags (whether git/session context was present)
 *
 * NEVER contains:
 *   - Enhanced prompt body
 *   - Raw user input / prompt draft
 *   - API keys or auth headers
 *   - Raw Usage cost objects
 *   - System prompt
 *   - Full model result
 */
export function buildDebugArtifact(result: EnhancePromptResult): string {
  const m = result.metadata;
  const lines: string[] = [];

  // Header
  lines.push("=== pi-prompt-gen metadata artifact ===");
  lines.push("");

  // Metadata section — all string fields sanitized
  lines.push("--- Run metadata ---");
  if (m.modelId) lines.push(`Model ID:      ${sanitizeDisplayField(m.modelId)}`);
  if (m.modelName) lines.push(`Model name:    ${sanitizeDisplayField(m.modelName)}`);
  if (m.modelProvider) lines.push(`Provider:      ${sanitizeDisplayField(m.modelProvider)}`);
  if (m.latencyMs !== undefined) lines.push(`Latency:       ${m.latencyMs} ms`);
  lines.push(`Refs used:     ${m.refCount}`);
  if (m.browseToolsUsed?.length) {
    const cleanTools = sanitizeDisplayList(m.browseToolsUsed);
    lines.push(`Browse tools:  ${cleanTools.join(", ")}`);
  }
  lines.push(`Stop reason:   ${m.stopReason ? sanitizeDisplayField(m.stopReason) : "unknown"}`);
  if (m.usageSummary) {
    const u = m.usageSummary;
    const parts = [];
    if (u.input !== undefined) parts.push(`in: ${u.input}`);
    if (u.output !== undefined) parts.push(`out: ${u.output}`);
    if (u.totalTokens !== undefined) parts.push(`total: ${u.totalTokens}`);
    lines.push(`Tokens:        ${parts.join("  ")}`);
  }
  lines.push("");

  // Context section
  lines.push("--- Context ---");
  lines.push(`Has git context:    ${result.gitContext ? "yes" : "no"}`);
  lines.push(`Has session ctx:    ${result.sessionContext ? "yes" : "no"}`);
  if (result.refs.length > 0) {
    const refLines = result.refs
      .slice(0, MAX_REFS_IN_REPORT)
      .map((ref) => sanitizeDisplayField(ref.path, MAX_REF_PATH_CHARS))
      .filter((path) => path.length > 0)
      .map((path) => `  - ${path}`);
    if (refLines.length > 0) {
      lines.push("");
      lines.push("Refs:");
      lines.push(...refLines);
      if (result.refs.length > MAX_REFS_IN_REPORT) {
        lines.push(`  ... and ${result.refs.length - MAX_REFS_IN_REPORT} more`);
      }
    }
  }
  lines.push("");

  // Footer — note about deliberately excluded content
  lines.push("--- End metadata artifact ---");
  lines.push("");
  lines.push("Note: The enhanced prompt body, raw user input, system prompt, and full");
  lines.push("model result are intentionally excluded from this artifact because they");
  lines.push("may contain sensitive data, secrets, or raw user input echoed by the model.");

  return lines.join("\n");
}
