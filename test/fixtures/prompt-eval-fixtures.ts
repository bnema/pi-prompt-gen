/**
 * Prompt eval fixture data.
 *
 * Each fixture is a representative input that the pi-prompt-gen enhancer
 * should handle. Fixtures cover seven categories:
 *
 *   vague        – vague or under-specified implementation asks
 *   bug-fix      – bug reports that must not be debugged by the enhancer
 *   follow-up    – follow-up work referencing previous changes
 *   code-review  – code review requests
 *   docs         – documentation / explanation requests
 *   implement    – clear, scoped implementation tasks with specific requirements
 *   overly-broad – prompts too large in scope that need narrowing
 *
 * Fixtures are consumed by test/prompt-evals.test.ts. Add a new fixture
 * entry here, then optionally add custom assertions in the test file if
 * the category needs checks beyond the defaults.
 *
 * When to update expected behaviour:
 *   - If the enhancer prompt (/src/enhancer-prompt.ts) gains new constraints
 *     or loses existing ones, update the fixture's expected labels or the
 *     shared criteria in prompt-evals.test.ts.
 *   - If a new category of user input is added, add a fixture here.
 *   - If the prompt-shaping pipeline gains new context types (e.g., test
 *     coverage summaries), add optional context entries here.
 */

import type { EnhancerMode } from "../../src/enhancer-prompt.js";
import type { GitContext, RelevantRef, SessionContext } from "../../src/index.js";

// ---------------------------------------------------------------------------
// Shared criteria names — used by the fixture interface and the eval runner.
// Keeping them here means fixture authors get compile-time feedback when a
// skipCriteria value doesn't match a known assertion label.
// ---------------------------------------------------------------------------

/**
 * All default property-level criteria checked by the eval runner.
 * Fixtures can opt out of individual criteria via `skipCriteria`.
 */
export const DEFAULT_CRITERIA = [
  "scope-lock",
  "change-budget",
  "role-framing",
  "anti-debug",
  "anti-essay",
  "output-contract",
  "verification-guidance",
  "task-shape-guidance",
  "no-task-solving",
  "no-meta-commentary",
  "no-user-input-in-system-prompt",
] as const;

/** A valid criteria name used by the eval runner. */
export type CriteriaName = (typeof DEFAULT_CRITERIA)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single prompt eval fixture.
 *
 * Each fixture describes one input scenario, optionally with bounded
 * browse-context data that the enhancer should fold into the system prompt.
 */
export interface PromptEvalFixture {
  /** Unique identifier for this fixture (kebab-case). */
  id: string;
  /** Human-readable category label. */
  category: string;
  /** The raw user input (what the user typed). */
  input: string;
  /**
   * Expected enhancement mode. "rewrite" for prompts that already express
   * an ask that needs polishing; "generate" for rough ideas that need full
   * prompt construction.
   */
  mode: EnhancerMode;
  /** Short description of what this fixture represents. */
  description: string;
  /** Optional bounded context to supply alongside the input. */
  context?: {
    /** File references selected by a browse pass. */
    relevantRefs?: Array<string | RelevantRef>;
    /** Bounded git context. */
    gitContext?: GitContext;
    /** Bounded session conversation context. */
    sessionContext?: SessionContext;
  };
  /**
   * Which property-level assertions to skip for this fixture.
   * Values correspond to criteria names used in the eval runner.
   * Omitted or empty means all default criteria apply.
   */
  skipCriteria?: CriteriaName[];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const PROMPT_EVAL_FIXTURES: PromptEvalFixture[] = [
  // =========================================================================
  // 1. Vague implementation asks
  // =========================================================================
  {
    id: "vague-sidebar-sort",
    category: "vague",
    input: "fix the sidebar sort order",
    mode: "rewrite",
    description:
      "A vague implementation request with no details about desired order, " +
      "sort field, or component name. The enhancer should sharpen the wording " +
      "without expanding the scope.",
    context: {
      relevantRefs: [
        {
          path: "src/components/Sidebar.tsx",
          reason: "Likely owner of sidebar ordering behavior",
          role: "implementation",
          symbols: ["Sidebar"],
        },
        "src/components/SidebarList.tsx",
      ],
      gitContext: {
        branch: "feat/sidebar-improvements",
        statusSummary: "1 staged, 2 unstaged files.",
        changedFiles: ["src/components/Sidebar.tsx"],
        changedFileDetails: [
          {
            path: "src/components/Sidebar.tsx",
            status: "modified",
            staged: true,
            unstaged: true,
            untracked: false,
            additions: 12,
            deletions: 3,
          },
        ],
        diffSummary: "Recent local changes adjust sidebar layout props.",
      },
    },
  },
  {
    id: "vague-button-color",
    category: "vague",
    input: "make the button blue",
    mode: "rewrite",
    description:
      "A minimal prompt lacking the button type, context, and target file.",
  },
  {
    id: "vague-performance",
    category: "vague",
    input: "make the app faster",
    mode: "generate",
    description:
      "A performance concern with zero specifics. Should generate a prompt " +
      "that asks for profiling data / reproduction steps before making changes.",
  },

  // =========================================================================
  // 2. Bug fixes
  // =========================================================================
  {
    id: "bug-crash-on-submit",
    category: "bug-fix",
    input: "The form crashes when I submit with empty fields. It shows a 500 error in the console.",
    mode: "generate",
    description:
      "A bug report that describes a crash. The enhancer must NOT debug the " +
      "issue itself — it must produce a prompt that asks another agent to fix it.",
    context: {
      relevantRefs: ["src/components/ContactForm.tsx", "src/api/submit-form.ts"],
      gitContext: {
        branch: "feat/form-validation",
        statusSummary: "3 unstaged files.",
        changedFiles: ["src/components/ContactForm.tsx", "src/api/submit-form.ts"],
      },
    },
  },
  {
    id: "bug-login-not-redirecting",
    category: "bug-fix",
    input: "After login, the user is not redirected to the dashboard. They stay on the login page even though the auth token is set.",
    mode: "generate",
    description:
      "A login flow bug. The enhancer must produce a prompt that directs " +
      "another agent to investigate the redirect logic, not debug it inline.",
    context: {
      relevantRefs: ["src/auth/login.ts", "src/auth/redirect.ts", "src/pages/Login.tsx"],
    },
  },
  {
    id: "bug-data-not-refreshing",
    category: "bug-fix",
    input: "The dashboard doesn't refresh when new data comes in. I have to manually reload the page.",
    mode: "rewrite",
    description:
      "A vague bug with no reproduction steps. The enhancer should preserve " +
      "the original ask and add structure for investigating the data-refresh path.",
  },

  // =========================================================================
  // 3. Follow-up work
  // =========================================================================
  {
    id: "follow-up-auth-cleanup",
    category: "follow-up",
    input: "Based on the last PR review, clean up the error handling in the auth module. Use consistent error types and remove duplicated try-catch blocks.",
    mode: "rewrite",
    description:
      "A follow-up task referencing a previous review. The enhancer must " +
      "preserve the narrow scope and include the specific instructions.",
    context: {
      relevantRefs: ["src/auth/login.ts", "src/auth/register.ts", "src/auth/errors.ts"],
      gitContext: {
        branch: "fix/auth-error-handling",
        statusSummary: "5 unstaged, 2 staged files.",
        changedFiles: [
          "src/auth/login.ts",
          "src/auth/register.ts",
          "src/auth/errors.ts",
          "src/auth/tokens.ts",
        ],
        diffSummary: "WIP error handling cleanup; duplicates present in login and register.",
      },
      sessionContext: {
        relevantMessages: [
          {
            role: "user",
            text: "Review the auth module error handling in PR #42 and suggest improvements.",
          },
          {
            role: "assistant",
            text:
              "The error handling duplicates patterns between login.ts and " +
              "register.ts. A follow-up should consolidate error types into " +
              "errors.ts and remove the duplicated try-catch blocks.",
          },
        ],
      },
    },
  },
  {
    id: "follow-up-migration-batch",
    category: "follow-up",
    input: "Add batch processing to the user migration script. Process 100 users at a time instead of all at once.",
    mode: "rewrite",
    description:
      "A follow-up that extends an existing script. The enhancer should keep " +
      "the scope tight and not suggest other architectural changes.",
    context: {
      relevantRefs: ["scripts/migrate-users.ts"],
    },
  },

  // =========================================================================
  // 4. Code review requests
  // =========================================================================
  {
    id: "code-review-permissions",
    category: "code-review",
    input: "Can you review my PR for the user permissions feature? Look at the access control in middleware.ts and the role checks in the API routes.",
    mode: "rewrite",
    description:
      "A code review request. The enhancer must produce a prompt that asks " +
      "another agent to perform the review, not do the review itself.",
    context: {
      relevantRefs: ["src/middleware/access-control.ts", "src/api/routes/users.ts", "src/api/routes/admin.ts"],
      gitContext: {
        branch: "feat/user-permissions",
        statusSummary: "8 changed files.",
        changedFiles: [
          "src/middleware/access-control.ts",
          "src/api/routes/users.ts",
          "src/api/routes/admin.ts",
        ],
        diffSummary: "Adds role-based access control with admin/user roles and route guards.",
      },
    },
  },
  {
    id: "code-review-styling",
    category: "code-review",
    input: "Review the CSS changes in the dashboard refactor. Check for responsive issues and unused styles.",
    mode: "rewrite",
    description:
      "A CSS-focused code review. The enhancer should scope the prompt to " +
      "style review only, not feature logic.",
    context: {
      relevantRefs: ["src/styles/dashboard.css", "src/styles/responsive.css"],
      sessionContext: {
        relevantMessages: [
          { role: "user", text: "The dashboard cards looked cramped on mobile in the last review." },
          { role: "assistant", text: "Focus the follow-up review on responsive spacing and unused selectors only." },
        ],
      },
    },
  },

  // =========================================================================
  // 5. Documentation requests
  // =========================================================================
  {
    id: "docs-api-endpoint",
    category: "docs",
    input: "Write docs for the new API endpoint that exports user data as CSV.",
    mode: "generate",
    description:
      "A documentation request for a specific endpoint. The enhancer should " +
      "generate a prompt that asks another agent to produce docs, not write them.",
    context: {
      relevantRefs: ["src/api/routes/export-users.ts", "src/services/csv-export.ts"],
    },
  },
  {
    id: "docs-setup-guide",
    category: "docs",
    input: "Write a getting-started guide for new developers joining the project.",
    mode: "generate",
    description:
      "A broad documentation request for setup docs. The enhancer should " +
      "scope the output to docs-generation without trying to write the guide.",
    skipCriteria: ["verification-guidance"],
  },
  {
    id: "docs-readme-update",
    category: "docs",
    input: "Update the README with the new configuration options and environment variables.",
    mode: "rewrite",
    description:
      "An existing README that needs updating. Rewrite mode to refine the ask " +
      "into a specific docs-update prompt.",
    context: {
      relevantRefs: ["README.md", "docs/configuration.md"],
    },
  },

  // =========================================================================
  // 6. Implementation tasks (clear, scoped features)
  // =========================================================================
  {
    id: "implement-add-user-api",
    category: "implement",
    input: "Add a POST /api/users endpoint that creates a new user from the request body. Validate email format, hash the password with bcrypt, and return the created user without the password field.",
    mode: "rewrite",
    description:
      "A clear implementation task with specific requirements. The enhancer " +
      "should produce a compact structured prompt with Goal, Context, " +
      "Constraints, and Verification sections.",
    context: {
      relevantRefs: ["src/api/routes/users.ts", "src/models/user.ts"],
      gitContext: {
        branch: "feat/add-users-api",
        statusSummary: "3 unstaged files.",
        changedFiles: ["src/api/routes/users.ts"],
      },
    },
  },
  {
    id: "implement-export-scheduler",
    category: "implement",
    input: "Create a scheduler service that runs the CSV export job every hour. Use the existing cron utility in src/utils/cron.ts. Log start/end and errors.",
    mode: "rewrite",
    description:
      "An implementation task referencing an existing utility. The enhancer " +
      "should keep the scope tight and reference the existing utility.",
    context: {
      relevantRefs: ["src/utils/cron.ts", "src/services/csv-export.ts"],
    },
  },

  // =========================================================================
  // 7. Overly broad prompts
  // =========================================================================
  {
    id: "broad-full-stack-app",
    category: "overly-broad",
    input: "Build me a full-stack application with user authentication, a dashboard, real-time notifications, and an admin panel.",
    mode: "generate",
    description:
      "A massively broad prompt asking for an entire application. The enhancer " +
      "must produce a prompt that narrows the scope and asks for prioritisation.",
  },
  {
    id: "broad-rewrite-everything",
    category: "overly-broad",
    input: "Rewrite the entire codebase from JavaScript to TypeScript, add tests for everything, and migrate the database.",
    mode: "rewrite",
    description:
      "A multi-workstream rewrite request. The enhancer should preserve the " +
      "overall goal and produce a scoped prompt for one phase at a time.",
    context: {
      gitContext: {
        branch: "main",
        statusSummary: "Working tree clean.",
        changedFiles: [],
      },
    },
  },
  {
    id: "broad-redesign-with-features",
    category: "overly-broad",
    input: "Redesign the UI, add dark mode, internationalisation, and real-time collaboration. Also make it accessible.",
    mode: "generate",
    description:
      "A wide-ranging design + features request. The enhancer should scope " +
      "the output to a single deliverable per prompt and suggest breaking it up.",
  },
];

/**
 * Map from fixture id to fixture for quick lookup.
 */
export const FIXTURE_BY_ID: ReadonlyMap<string, PromptEvalFixture> = new Map(
  PROMPT_EVAL_FIXTURES.map((fixture) => [fixture.id, fixture]),
);
