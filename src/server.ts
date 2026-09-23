/**
 * MCP tool registration.
 *
 * Three tools, matching the contract in the README:
 *
 *   submit_for_review  - the gate. The agent calls this when it believes it is done.
 *   configure_project  - per-repo thresholds, toggles and retry budget.
 *   get_review_log     - what happened, and why.
 *
 * Everything returned to the agent is also returned as `structuredContent` so a
 * caller can branch on the verdict programmatically instead of parsing prose.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GATE_DIMENSIONS, type Verdict } from "./types.js";
import {
  CONFIG_FILENAME,
  MAX_RETRIES_LIMIT,
  PRESETS,
  SCOPE_LIMITS,
  loadConfig,
  saveConfig,
  type PartialVibecheckConfig,
} from "./config.js";
import { log } from "./logger.js";
import { renderVerdictText, submitForReview } from "./review/orchestrator.js";
import { recordReset, summariseLog, taskFingerprint } from "./review/ledger.js";
import { DIMENSION_LABELS } from "./questions.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function text(body: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: body }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function failure(message: string, detail?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    ...(detail ? { structuredContent: detail } : {}),
    isError: true,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerSubmitForReview(server);
  registerConfigureProject(server);
  registerGetReviewLog(server);

  return server;
}

/* ------------------------------------------------------------------ *
 * submit_for_review
 * ------------------------------------------------------------------ */

const changedFileSchema = z.object({
  path: z.string().describe("Path of the changed file, relative to the project root."),
  diff: z.string().optional().describe("Unified diff for this file, if you have it."),
  content: z.string().optional().describe("Full new contents of the file, if you have them."),
});

function registerSubmitForReview(server: McpServer): void {
  server.registerTool(
    "submit_for_review",
    {
      title: "Submit work for completion review",
      description: [
        "Call this when you believe a task is complete, before telling the user you are finished.",
        "",
        "An external judge (TypeSafe AI's Jev decision model) scores the change against eight dimensions and returns a verdict.",
        "If the verdict is `needs_fixes`, address every item in `feedback` in order and call this tool again.",
        "If it is `max_retries_exceeded`, stop: report to the user that the change did not pass review, and list the outstanding issues.",
        "If it is `needs_clarification`, the request itself stated nothing checkable. Say what you took it to mean, then resubmit with that in `notes`; no retry is used.",
        "",
        "The review is performed against git's view of the repository when `project_root` is a git repository, so the change set does not depend on this argument being complete.",
      ].join("\n"),
      inputSchema: {
        task_description: z
          .string()
          .min(1)
          .describe("The user's original request, as close to verbatim as possible. This is what 'satisfies the request' is judged against, so do not summarise it into a favourable paraphrase."),
        changed_files: z
          .array(changedFileSchema)
          .optional()
          .describe("The files you changed. Required when project_root is not a git repository. On a repository, git supplies the change set, but listing the files still helps: a file git cannot place inside the reviewed range widens that range to include it, so report the whole change rather than one file from it."),
        project_root: z
          .string()
          .optional()
          .describe("Absolute path to the project. Defaults to the server's working directory. Used to find .vibecheck.json, sample conventions, and read git."),
        test_results: z
          .union([z.string(), z.record(z.unknown())])
          .optional()
          .describe("Output from the test run, or an object such as {passed, failures, output}. Failing tests are a hard gate, so include this when you ran tests."),
        attempt_number: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Which attempt this is. Advisory only: the server counts attempts itself from its own log."),
        notes: z
          .string()
          .optional()
          .describe(
            "Anything the judge should know that is not visible in the diff: why an apparent shortcut is deliberate, and - when the request is open-ended - the acceptance criteria you are working to. Criteria here make an otherwise unverifiable request judgeable.",
          ),
      },
    },
    async (args) => {
      try {
        const result = await submitForReview({
          task_description: args.task_description,
          changed_files: args.changed_files,
          project_root: args.project_root,
          test_results: args.test_results,
          attempt_number: args.attempt_number,
          notes: args.notes,
        });
        return text(renderVerdictText(result), result as unknown as Record<string, unknown>);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("submit_for_review failed unexpectedly", { message });
        return failure(
          `vibe-check could not complete the review because of an internal error: ${message}\n\nThis is a bug in the server, not a verdict on your change. Retry once; if it persists, report that the completion review is unavailable and describe what you changed.`,
          { verdict: "review_unavailable", review_performed: false, error: message },
        );
      }
    },
  );
}

/* ------------------------------------------------------------------ *
 * configure_project
 * ------------------------------------------------------------------ */

function registerConfigureProject(server: McpServer): void {
  const questionSchema = z.object({
    enabled: z.boolean().optional(),
    threshold: z.number().min(0).max(1).optional().describe("Normalised 0-1 pass threshold; scores below it fail."),
    weight: z.number().positive().optional().describe("Relative importance. Orders the fix list; does not gate."),
  });

  server.registerTool(
    "configure_project",
    {
      title: "Configure vibe-check for a project",
      description: [
        `Write or update ${CONFIG_FILENAME} in the project root.`,
        "",
        "Use `preset` to select a baseline posture - `lenient` for prototypes and spikes, `balanced` (default) for everyday application code, `strict` for production services and libraries - then override individual dimensions as needed.",
        "Thresholds are normalised 0-1 where 1 is always good.",
        "For the graded dimensions (readability, error_handling_present, test_coverage_adequate) the raw scale has four levels, so 0.33 means 'level 1 of 3' and 0.67 means 'level 2 of 3'.",
        "Judge credentials are never stored here: the API key is read from the server's environment.",
      ].join("\n"),
      inputSchema: {
        project_root: z.string().optional().describe("Project root. Defaults to the server's working directory."),
        preset: z.enum(PRESETS as [string, ...string[]]).optional(),
        max_retries: z
          .number()
          .int()
          .min(1)
          .max(MAX_RETRIES_LIMIT)
          .optional()
          .describe(
            "Maximum submissions for one request before escalating to the user. Counted server-side from the log, so the agent cannot reset it. Default 10: a budget that runs out while a fix list is still shrinking turns a fixable change into an escalation. Lower it for a short leash.",
          ),
        questions: z
          .record(z.enum(GATE_DIMENSIONS as [string, ...string[]]), questionSchema)
          .optional()
          .describe("Per-dimension overrides."),
        conventions: z
          .object({
            mode: z.enum(["auto", "file", "off"]).optional().describe("`auto` samples the repo, `file` reads a style guide, `off` disables convention sampling."),
            style_guide: z.string().optional().describe("Path to a style guide, relative to the project root. Used with mode `file`."),
            sample_size: z.number().int().min(1).max(50).optional(),
          })
          .optional(),
        judge: z
          .object({
            provider: z
              .enum(["auto", "typesafe", "mock"])
              .optional()
              .describe("`auto` (default) calls Jev when TYPESAFE_API_KEY is set and the offline mock otherwise. `typesafe` requires the key; `mock` is the heuristic stand-in for testing plumbing."),
            model: z.string().optional().describe("Defaults to jev-latest. Pin a versioned id once you have tuned thresholds."),
            diagnostics: z.boolean().optional().describe("Ask the extra questions that name the kind of failure. Leave on: they are what make the fix instructions specific."),
          })
          .optional(),
        budget: z
          .object({
            max_state_chars: z.number().int().min(2000).max(400000).optional(),
            max_chars_per_file: z.number().int().min(500).max(200000).optional(),
            max_changed_files: z.number().int().min(1).max(2000).optional(),
          })
          .optional(),
        hard_gates: z
          .object({
            failing_tests: z.boolean().optional(),
            committed_secret: z.boolean().optional(),
            submission_mismatch: z.boolean().optional(),
          })
          .optional(),
        intent: z
          .object({
            on_unverifiable_request: z
              .enum(["clarify", "judge"])
              .optional()
              .describe(
                "What to do when the task description states no checkable requirement. `clarify` (default) refuses to judge it and asks for acceptance criteria, because neither available verdict would be true; `judge` scores it anyway and gates on satisfies_request as usual.",
              ),
          })
          .optional(),
        scope: z
          .object({
            mode: z
              .enum(["auto", "last-commit", "working-tree"])
              .optional()
              .describe("How much of the repository a review covers when the branch has no base to compare against. `auto` (default) reviews the trailing run of commits that plausibly belongs to the task, widened by the files you report; `last-commit` reviews only the newest commit; `working-tree` never looks at committed work."),
            max_commits: z
              .number()
              .int()
              .min(1)
              .max(SCOPE_LIMITS.maxCommits)
              .optional()
              .describe("Hard cap on how many commits one review may span. Default 20."),
            max_age_hours: z
              .number()
              .min(0)
              .max(SCOPE_LIMITS.maxAgeHours)
              .optional()
              .describe("How far back a commit may be, in hours, and still count as task work. A file you explicitly report changing is reached regardless of age, within max_commits. Default 12."),
          })
          .optional(),
        reset_attempts: z
          .boolean()
          .optional()
          .describe("Clear the retry budget for this project's tasks, or for a single task if task_description and changed_files are also given."),
        task_description: z
          .string()
          .optional()
          .describe("With reset_attempts, narrows the reset to this one request instead of every request in the project."),
        dry_run: z.boolean().optional().describe("Show what would be written without writing it."),
      },
    },
    async (args) => {
      try {
        const overrides: PartialVibecheckConfig = {};
        if (args.preset) overrides.preset = args.preset as PartialVibecheckConfig["preset"];
        if (args.max_retries !== undefined) overrides.maxRetries = args.max_retries;
        if (args.questions) overrides.questions = args.questions as PartialVibecheckConfig["questions"];
        if (args.conventions) {
          overrides.conventions = {
            ...(args.conventions.mode ? { mode: args.conventions.mode as "auto" | "file" | "off" } : {}),
            ...(args.conventions.style_guide ? { styleGuide: args.conventions.style_guide } : {}),
            ...(args.conventions.sample_size !== undefined ? { sampleSize: args.conventions.sample_size } : {}),
          };
        }
        if (args.judge) {
          overrides.judge = {
            ...(args.judge.provider ? { provider: args.judge.provider as "auto" | "typesafe" | "mock" } : {}),
            ...(args.judge.model ? { model: args.judge.model } : {}),
            ...(args.judge.diagnostics !== undefined ? { diagnostics: args.judge.diagnostics } : {}),
          };
        }
        if (args.budget) {
          overrides.budget = {
            ...(args.budget.max_state_chars !== undefined ? { maxStateChars: args.budget.max_state_chars } : {}),
            ...(args.budget.max_chars_per_file !== undefined ? { maxCharsPerFile: args.budget.max_chars_per_file } : {}),
            ...(args.budget.max_changed_files !== undefined ? { maxChangedFiles: args.budget.max_changed_files } : {}),
          };
        }
        if (args.hard_gates) {
          overrides.hardGates = {
            ...(args.hard_gates.failing_tests !== undefined ? { failingTests: args.hard_gates.failing_tests } : {}),
            ...(args.hard_gates.committed_secret !== undefined ? { committedSecret: args.hard_gates.committed_secret } : {}),
            ...(args.hard_gates.submission_mismatch !== undefined
              ? { submissionMismatch: args.hard_gates.submission_mismatch }
              : {}),
          };
        }
        if (args.intent) {
          overrides.intent = {
            ...(args.intent.on_unverifiable_request
              ? { onUnverifiableRequest: args.intent.on_unverifiable_request as "clarify" | "judge" }
              : {}),
          };
        }
        if (args.scope) {
          overrides.scope = {
            ...(args.scope.mode ? { mode: args.scope.mode as "auto" | "last-commit" | "working-tree" } : {}),
            ...(args.scope.max_commits !== undefined ? { maxCommits: args.scope.max_commits } : {}),
            ...(args.scope.max_age_hours !== undefined ? { maxAgeHours: args.scope.max_age_hours } : {}),
          };
        }

        const resolved = loadConfig(args.project_root, overrides);
        // Surface merge problems before writing anything to disk.
        if (resolved.warnings.some((warning) => warning.includes("tool arguments"))) {
          return failure(
            `Those settings were rejected, so nothing was written:\n\n${resolved.warnings
              .map((warning) => `- ${warning}`)
              .join("\n")}`,
            { written: false, warnings: resolved.warnings },
          );
        }

        // Writing an empty config file would be noise: a project with defaults
        // does not need a file to say so.
        const hasOverrides = Object.keys(overrides).length > 0;
        const written = args.dry_run || !hasOverrides ? null : saveConfig(resolved.projectRoot, overrides);

        if (args.reset_attempts) {
          const fingerprint =
            args.task_description !== undefined ? taskFingerprint(args.task_description) : null;
          recordReset(resolved.stateDir, resolved.projectRoot, fingerprint);
        }

        const summary = renderConfig(
          resolved.config,
          written?.path ?? null,
          args.dry_run === true,
          hasOverrides,
          resolved.warnings,
        );
        log.info("configured project", { project: resolved.projectRoot, written: written?.path ?? null, dryRun: args.dry_run === true });

        return text(summary, {
          written: written !== null,
          config_path: written?.path ?? null,
          overrides_applied: hasOverrides,
          project_root: resolved.projectRoot,
          config: resolved.config as unknown as Record<string, unknown>,
          warnings: resolved.warnings,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(`Could not write the configuration: ${message}`, { written: false });
      }
    },
  );
}

function renderConfig(
  config: ReturnType<typeof loadConfig>["config"],
  configPath: string | null,
  dryRun: boolean,
  hasOverrides: boolean,
  warnings: string[],
): string {
  const lines: string[] = [];
  lines.push(`# ${dryRun ? "Proposed" : "Applied"} vibe-check configuration`);
  lines.push("");
  lines.push(`- Preset: **${config.preset}**`);
  lines.push(`- Max retries per task: **${config.maxRetries}**`);
  lines.push(`- Conventions: mode \`${config.conventions.mode}\`${config.conventions.styleGuide ? ` (${config.conventions.styleGuide})` : ""}, sample size ${config.conventions.sampleSize}`);
  lines.push(`- Review scope: mode \`${config.scope.mode}\`, up to ${config.scope.maxCommits} commits, ${config.scope.maxAgeHours}h window`);
  lines.push(`- Unverifiable requests: \`${config.intent.onUnverifiableRequest}\``);
  lines.push(`- Judge: \`${config.judge.provider}\` model \`${config.judge.model}\`, diagnostics ${config.judge.diagnostics ? "on" : "off"}`);
  lines.push(`- Hard gates: ${Object.entries(config.hardGates).filter(([, on]) => on).map(([name]) => name).join(", ") || "none"}`);
  lines.push("");
  lines.push("| dimension | enabled | threshold | weight |");
  lines.push("| --- | --- | --- | --- |");
  for (const dimension of GATE_DIMENSIONS) {
    const question = config.questions[dimension];
    if (!question) continue;
    lines.push(
      `| ${DIMENSION_LABELS[dimension]} | ${question.enabled ? "yes" : "no"} | ${question.threshold.toFixed(2)} | ${question.weight} |`,
    );
  }
  lines.push("");
  lines.push(
    configPath
      ? `Written to ${configPath}.`
      : dryRun
        ? `Dry run: nothing written. It would be saved to ${CONFIG_FILENAME} in the project root.`
        : hasOverrides
          ? `No configuration file was written.`
          : `No overrides were supplied, so nothing was written. The values above are this project's effective configuration.`,
  );
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * get_review_log
 * ------------------------------------------------------------------ */

function registerGetReviewLog(server: McpServer): void {
  server.registerTool(
    "get_review_log",
    {
      title: "Read the review log for a project",
      description: [
        "Return recent reviews and verdicts for a project, so you can see why an agent looped or what was still failing at the end.",
        "Each entry records the attempt number, the verdict, every dimension score, which gates fired, and which judge produced the verdict.",
        "Reading the log never consumes a retry.",
      ].join("\n"),
      inputSchema: {
        project_root: z.string().optional().describe("Project root. Defaults to the server's working directory."),
        limit: z.number().int().min(1).max(200).optional().describe("How many recent entries to return. Default 10."),
        verdict: z
          .enum(["approved", "needs_fixes", "max_retries_exceeded", "review_unavailable", "needs_clarification"])
          .optional()
          .describe("Only return entries with this verdict."),
        task_description: z
          .string()
          .optional()
          .describe("Filters the log to a single request. Retry budgets are keyed on the request wording alone."),
      },
    },
    async (args) => {
      try {
        const resolved = loadConfig(args.project_root);
        const fingerprint = args.task_description ? taskFingerprint(args.task_description) : undefined;

        const summary = summariseLog(resolved.stateDir, resolved.projectRoot, {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.verdict ? { verdict: args.verdict as Verdict } : {}),
          ...(fingerprint ? { fingerprint } : {}),
        });

        return text(
          renderLog(summary, fingerprint ?? null),
          summary as unknown as Record<string, unknown>,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(`Could not read the review log: ${message}`);
      }
    },
  );
}

function renderLog(summary: ReturnType<typeof summariseLog>, fingerprint: string | null): string {
  const lines: string[] = [];
  lines.push(`# vibe-check review log`);
  lines.push("");
  lines.push(`Project: ${summary.project}`);
  lines.push(`Log file: ${summary.log_file}`);
  if (fingerprint) lines.push(`Filtered to task fingerprint: ${fingerprint}`);
  lines.push("");
  lines.push(`Reviews recorded: **${summary.total_reviews}**`);
  if (Object.keys(summary.by_verdict).length > 0) {
    lines.push("");
    lines.push("| verdict | count |");
    lines.push("| --- | --- |");
    for (const [verdict, count] of Object.entries(summary.by_verdict)) {
      lines.push(`| ${verdict} | ${count} |`);
    }
  }

  if (summary.top_failing_dimensions.length > 0) {
    lines.push("");
    lines.push("## Dimensions that failed most often");
    lines.push("");
    for (const entry of summary.top_failing_dimensions) {
      lines.push(`- ${DIMENSION_LABELS[entry.dimension as keyof typeof DIMENSION_LABELS] ?? entry.dimension}: ${entry.count}`);
    }
  }

  if (summary.recent.length === 0) {
    lines.push("");
    lines.push("No reviews have been recorded for this project yet.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("## Recent reviews (newest first)");
  for (const entry of summary.recent) {
    lines.push("");
    lines.push(`### ${entry.ts} — ${entry.verdict ?? "unknown"}`);
    lines.push(`Attempt ${entry.attempt ?? "?"}; judge ${entry.judge?.provider ?? "?"} (${entry.judge?.model ?? "?"}), ${entry.judge?.latency_ms ?? "?"}ms`);
    if (entry.task_preview) lines.push(`Task: ${entry.task_preview}`);
    if (entry.evidence_source) lines.push(`Evidence: ${entry.evidence_source}`);
    if (entry.scope) lines.push(`Scope: \`${entry.scope.rule}\`, ${entry.scope.commits} commit(s) — ${entry.scope.range}`);
    if (entry.changed_files && entry.changed_files.length > 0) {
      lines.push(`Files: ${entry.changed_files.slice(0, 10).join(", ")}${entry.changed_files.length > 10 ? ` (+${entry.changed_files.length - 10} more)` : ""}`);
    }
    const scores = Object.entries(entry.scores ?? {});
    if (scores.length > 0) {
      lines.push("");
      lines.push(`Scores: ${scores.map(([dimension, value]) => `${dimension} ${value.score.toFixed(2)}${value.passed ? "" : " FAIL"}`).join(", ")}`);
    }
    if (entry.hard_gates && entry.hard_gates.length > 0) {
      lines.push(`Hard gates fired: ${entry.hard_gates.join(", ")}`);
    }
    if (entry.note) lines.push(`Note: ${entry.note}`);
  }

  return lines.join("\n");
}
