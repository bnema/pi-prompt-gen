/**
 * Shared bound constants for rich-ref metadata.
 *
 * Both the browse scout (browse-pass.ts) and the final prompt renderer
 * (enhancer-prompt.ts) apply these same limits to ref reason, role, and
 * symbol fields. Keeping them in one place prevents drift.
 */

/** Maximum characters for a ref rationale string. */
export const MAX_REASON_CHARS = 200;

/** Maximum characters for a ref role/context label. */
export const MAX_ROLE_CHARS = 50;

/** Maximum number of symbols listed per ref. */
export const MAX_SYMBOLS = 5;

/** Maximum characters per individual symbol. */
export const MAX_SYMBOL_CHARS = 100;
