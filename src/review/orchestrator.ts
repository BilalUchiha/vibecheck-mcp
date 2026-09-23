/**
 * The submission pipeline.
 *
 * Order matters here and is deliberate:
 *
 *   collect (git, not the agent's word) -> sample conventions -> analyse ->
 *   build state -> ask Jev once -> evaluate -> translate to feedback -> count
 *   the attempt -> decide the verdict -> log.
 *
 * Attempt counting happens after the review so that a reviewer failure does not
 * consume the agent's budget, and the verdict is computed last so that it can
 * take the remaining budget into account.
 */

import { analyseChanges } from "../context/analyze.js";
import { collectChangedFiles, parseTestResults, type SubmittedFile } from "../context/collect.js";
import { assessRequest, type RequestAssessment } from "../context/request.js";
import { buildConventionReference, type ConventionReference } from "../context/conventions.js";
import { buildReviewState } from "../context/state.js";
import { loadConfig, resolveJudgeProvider, type LoadResult, type VibecheckConfig } from "../config.js";
import { buildJudgeQuestions } from "../questions.js";
import { createJudge, JevError, remediationFor } from "../jev/index.js";
import { log } from "../logger.js";
import { buildFeedback } from "./feedback.js";
import { evaluate, type EvaluationResult } from "./evaluate.js";
import { appendEntry, countAttempts, taskFingerprint } from "./ledger.js";
import type {
  AnalysisReport,
  ChangedFile,
  FeedbackItem,
  TestResults,
  Verdict,
} from "../types.js";
import type { JevAnswer } from "../types.js";

export interface SubmitArgs {
  task_description: string;
  changed_files?: SubmittedFile[] | undefined;
  project_root?: string | undefined;
  test_results?: unknown;
  /** Advisory only: the server counts attempts itself. */
  attempt_number?: number | undefined;
  notes?: string | undefined;
}

export interface ScoreReport {
  score: number;
  threshold: number;
  passed: boolean;
  weight: number;
  kind: string;
  tier: string;
  confidence: number | null;
  /** For graded dimensions, the level description the score landed on. */
  level: string | null;
  /** Machine-readable failure reason from the diagnostic question, if any. */
  reason: string | null;
}

export interface SubmitResult {
  verdict: Verdict;
  approved: boolean;
  /** False when the review could not run; `verdict` is then `review_unavailable`. */
  review_performed: boolean;
  scores: Record<string, ScoreReport>;
  diagnostics: Record<string, string>;
  feedback: FeedbackItem[];
  attempts_remaining: number;
  attempt_number: number;
  max_retries: number;
  summary: string;
  next_action: string;
  warnings: string[];
  hard_gate_failures: { gate: string; message: string; evidence: string[] }[];
  evidence: {
    source: string;
    base: string | null;
    changed_files: string[];
    /** Which commits were reviewed, and how that range was chosen. */
    scope: {
      rule: string;
      description: string;
      commits: number;
      window_hours: number | null;
      unreached_claims: string[];
    } | null;
  };
  judge: { provider: string; model: string; latency_ms: number; caveat: string | null };
  judge_error: { kind: string; message: string; remediation: string } | null;
  /** Whether the request itself was checkable, and why. */
  intent: RequestAssessment;
  config_used: { preset: string; config_path: string | null; diagnostics: boolean };
}

export async function submitForReview(args: SubmitArgs): Promise<SubmitResult> {
  const resolved: LoadResult = loadConfig(args.project_root);
  const { config, projectRoot, stateDir } = resolved;
  const warnings: string[] = [...resolved.warnings];

  const submitted = normaliseSubmitted(args.changed_files);
  const collection = collectChangedFiles({
    projectRoot,
    submitted,
    maxFiles: config.budget.maxChangedFiles,
    scope: config.scope,
  });
  warnings.push(...collection.warnings);

  // A request with nothing checkable in it is detected before the judge is asked,
  // because neither verdict the judge could return would be true. See
  // `assessRequest`. This is checked before the conventions and analysis work so
  // an unjudgeable submission costs the server as little as it costs the agent.
  const assessment = assessRequest(args.task_description, args.notes);
  if (!assessment.verifiable && config.intent.onUnverifiableRequest === "clarify") {
    return requestClarification({
      assessment,
      projectRoot,
      stateDir,
      config,
      collection,
      taskDescription: args.task_description,
      warnings,
      priorAttempts: countAttempts(stateDir, taskFingerprint(args.task_description)),
    });
  }
  if (!assessment.verifiable) {
    warnings.push(
      `the request states no checkable requirement (${assessment.signals.join("; ")}), so satisfies_request is being judged against a request that does not define done${config.intent.onUnverifiableRequest === "judge" ? "; intent.onUnverifiableRequest is set to judge anyway" : ""}`,
    );
  }

  const conventions = buildConventionReference({
    projectRoot,
    repo: collection.repo,
    changedPaths: collection.files.map((file) => file.path),
    mode: config.conventions.mode,
    styleGuide: config.conventions.styleGuide,
    sampleSize: config.conventions.sampleSize,
    cacheTtlMs: config.conventions.cacheTtlMs,
  });
  warnings.push(...conventions.warnings);

  const analysis = analyseChanges({ files: collection.files, baseline: conventions.baseline });
  const testResults = parseTestResults(args.test_results);

  const state = buildReviewState({
    taskDescription: args.task_description,
    files: collection.files,
    analysis,
    conventions,
    testResults,
    evidenceSource: collection.evidenceSource,
    baseDescription: collection.baseDescription,
    scope: collection.scope,
    mismatch: collection.mismatch,
    config,
    assessment,
    notes: args.notes,
  });
  warnings.push(...state.warnings);

  const fingerprint = taskFingerprint(args.task_description);
  const priorAttempts = countAttempts(stateDir, fingerprint);
  const attemptNumber = priorAttempts + 1;

  log.info("reviewing submission", {
    attempt: attemptNumber,
    files: collection.files.length,
    evidence: collection.evidenceSource,
    stateChars: state.chars,
    conventionCacheHit: conventions.cacheHit,
  });

  const common = {
    config,
    projectRoot,
    stateDir,
    fingerprint,
    attemptNumber,
    collection,
    conventions,
    analysis,
    testResults,
    stateChars: state.chars,
    warnings,
    submitted,
    assessment,
  };

  const judge = createJudge(config);
  const questions = buildJudgeQuestions(config);
  let judgeResult;
  try {
    judgeResult = await judge.decide({ model: config.judge.model, state: state.state, questions });
  } catch (error) {
    return handleJudgeFailure(error, common);
  }

  const evaluation = evaluate({
    config,
    answers: judgeResult.answers,
    state: state.state,
    analysis,
    testResults,
    mismatch: collection.mismatch,
    diagnosticsEnabled: config.judge.diagnostics,
  });

  if (evaluation.unanswered.length > 0) {
    warnings.push(
      `the judge did not answer: ${evaluation.unanswered.join(", ")}; those dimensions were not used to decide the verdict`,
    );
  }

  const feedback = buildFeedback({
    scores: evaluation.scores,
    failed: evaluation.failed,
    hardGateFailures: evaluation.hardGateFailures,
    analysis,
    files: collection.files,
    conventions,
    testResults,
    config,
    taskDescription: args.task_description,
  });

  const verdict = decideVerdict(evaluation.wouldApprove, attemptNumber, config.maxRetries);
  const attemptsRemaining = Math.max(0, config.maxRetries - attemptNumber);

  const result: SubmitResult = {
    verdict,
    approved: verdict === "approved",
    review_performed: true,
    scores: scoreReport(evaluation),
    diagnostics: diagnosticReport(judgeResult.answers),
    feedback,
    attempts_remaining: attemptsRemaining,
    attempt_number: attemptNumber,
    max_retries: config.maxRetries,
    summary: summariseVerdict(verdict, evaluation, feedback),
    next_action: nextAction(verdict, attemptsRemaining, config.maxRetries, evaluation, feedback),
    warnings,
    hard_gate_failures: evaluation.hardGateFailures,
    evidence: {
      source: collection.evidenceSource,
      base: collection.baseDescription,
      changed_files: collection.files.map((file) => file.path),
      scope: scopeReport(collection.scope),
    },
    judge: {
      provider: judgeResult.provider,
      model: judgeResult.model,
      latency_ms: judgeResult.latencyMs,
      caveat: judgeResult.caveat ?? null,
    },
    judge_error: null,
    intent: assessment,
    config_used: {
      preset: config.preset,
      config_path: resolved.configPath,
      diagnostics: config.judge.diagnostics,
    },
  };

  appendEntry(stateDir, {
    kind: "review",
    ts: new Date().toISOString(),
    project: projectRoot,
    fingerprint,
    attempt: attemptNumber,
    verdict,
    scores: Object.fromEntries(
      evaluation.scores.map((score) => [
        score.dimension,
        { score: round(score.score), threshold: score.threshold, passed: score.passed },
      ]),
    ),
    failed_dimensions: evaluation.failed.map((score) => score.dimension),
    hard_gates: evaluation.hardGateFailures.map((failure) => failure.gate),
    feedback_count: feedback.length,
    task_preview: args.task_description.trim().slice(0, 200),
    evidence_source: collection.evidenceSource,
    scope: collection.scope
      ? {
          rule: collection.scope.rule,
          commits: collection.scope.commits.length,
          range: collection.scope.description,
        }
      : null,
    changed_files: collection.files.slice(0, 50).map((file) => file.path),
    judge: {
      provider: judgeResult.provider,
      model: judgeResult.model,
      latency_ms: judgeResult.latencyMs,
      input_tokens: judgeResult.usage?.input_tokens ?? null,
    },
    config: { preset: config.preset, max_retries: config.maxRetries, config_path: resolved.configPath },
    warnings,
  });

  log.info("verdict", {
    verdict,
    attempt: attemptNumber,
    failed: evaluation.failed.map((score) => score.dimension),
    hardGates: evaluation.hardGateFailures.map((failure) => failure.gate),
  });

  return result;
}

/* ------------------------------------------------------------------ *
 * Verdict decisions
 * ------------------------------------------------------------------ */

function decideVerdict(approved: boolean, attemptNumber: number, maxRetries: number): Verdict {
  if (approved) return "approved";
  if (attemptNumber >= maxRetries) return "max_retries_exceeded";
  return "needs_fixes";
}

function summariseVerdict(
  verdict: Verdict,
  evaluation: EvaluationResult,
  feedback: FeedbackItem[],
): string {
  switch (verdict) {
    case "approved":
      return `Approved: all ${evaluation.scores.length} scored dimensions passed and no hard gates fired.`;
    case "needs_fixes": {
      const parts = [
        `${evaluation.failed.length} of ${evaluation.scores.length} dimension(s) below threshold`,
      ];
      if (evaluation.hardGateFailures.length > 0) {
        parts.push(`${evaluation.hardGateFailures.length} hard gate failure(s)`);
      }
      const top = feedback[0];
      if (top) parts.push(`highest priority: ${top.dimension} (${top.title})`);
      return `Not approved: ${parts.join("; ")}.`;
    }
    case "max_retries_exceeded":
      return `Not approved and out of retries: ${evaluation.failed.length} dimension(s) still below threshold after the final attempt.`;
    case "needs_clarification":
      return "The request states no checkable requirement, so no verdict was given.";
    default:
      return "The review could not be completed.";
  }
}

function nextAction(
  verdict: Verdict,
  attemptsRemaining: number,
  maxRetries: number,
  evaluation: EvaluationResult,
  feedback: FeedbackItem[],
): string {
  switch (verdict) {
    case "approved":
      return "Report completion to the user. If the judge provider was \"mock\", say so: that verdict came from the offline heuristic stand-in, not from Jev.";
    case "needs_fixes":
      return `Fix the items in \`feedback\` in the order given (they are sorted by severity), then call submit_for_review again. ${attemptsRemaining} of ${maxRetries} attempt(s) remain.`;
    case "max_retries_exceeded":
      return [
        "Stop iterating: the retry budget is exhausted and the task is NOT verified as complete.",
        "Report to the user explicitly that the completion review did not pass, and list the outstanding issues below.",
        `Unresolved dimensions: ${evaluation.failed.map((score) => score.dimension).join(", ") || "none recorded"}.`,
        feedback.length > 0
          ? `The most significant remaining issue is: ${feedback[0]?.title ?? ""} — ${feedback[0]?.instruction ?? ""}`
          : "",
        "Do not describe the task as finished.",
      ]
        .filter(Boolean)
        .join(" ");
    case "needs_clarification":
      return [
        "The request states no checkable requirement, so the change was not judged and no retry was used.",
        "Tell the user what you took the request to mean, then resubmit with those acceptance criteria in `notes`.",
      ].join(" ");
    default:
      return `Retry submit_for_review once. If the failure persists, tell the user the external completion review is unavailable and that the change has not been verified (${attemptsRemaining} of ${maxRetries} attempt(s) remain).`;
  }
}

/* ------------------------------------------------------------------ *
 * Clarification path
 * ------------------------------------------------------------------ */

interface ClarificationContext {
  assessment: RequestAssessment;
  projectRoot: string;
  stateDir: string;
  config: VibecheckConfig;
  collection: ReturnType<typeof collectChangedFiles>;
  taskDescription: string;
  warnings: string[];
  priorAttempts: number;
}

/**
 * The request states nothing checkable, so the review is refused rather than
 * scored. This is the honest answer to "does the result satisfy the request?"
 * when the request defines no done: neither `approved` nor `needs_fixes` would be
 * true, and a low `satisfies_request` score would blame the change for a gap in
 * the request.
 *
 * It is logged so the history explains why no verdict was reached, and it spends
 * no retry: the agent has nothing to fix. The fix is one line of context.
 */
function requestClarification(context: ClarificationContext): SubmitResult {
  const { assessment, config } = context;
  const signals = requestSignals(assessment);
  logClarification(context, signals);

  return {
    verdict: "needs_clarification",
    approved: false,
    review_performed: false,
    scores: {},
    diagnostics: {},
    feedback: [],
    attempts_remaining: Math.max(0, config.maxRetries - context.priorAttempts),
    attempt_number: context.priorAttempts + 1,
    max_retries: config.maxRetries,
    summary: `The request states no checkable requirement, so the review refused to score it: ${assessment.signals.join("; ")}.`,
    next_action: clarificationGuidance(context.taskDescription, assessment),
    warnings: [...context.warnings, ...signals],
    hard_gate_failures: [],
    evidence: {
      source: context.collection.evidenceSource,
      base: context.collection.baseDescription,
      changed_files: context.collection.files.map((file) => file.path),
      scope: scopeReport(context.collection.scope),
    },
    judge: { provider: "not_consulted", model: "not_consulted", latency_ms: 0, caveat: null },
    judge_error: null,
    intent: assessment,
    config_used: {
      preset: config.preset,
      config_path: null,
      diagnostics: config.judge.diagnostics,
    },
  };
}

/** The assessment's reasons, prefixed so they read as warnings about the request. */
function requestSignals(assessment: RequestAssessment): string[] {
  return assessment.signals.map((signal) => `request: ${signal}`);
}

/**
 * Recorded so the history explains why no verdict was reached. `needs_clarification`
 * is not counted as an attempt, so this entry documents the refusal without
 * spending the agent's budget.
 */
function logClarification(context: ClarificationContext, signals: string[]): void {
  log.info("request needs clarification", {
    signals: context.assessment.signals,
    files: context.collection.files.length,
  });

  appendEntry(context.stateDir, {
    kind: "review",
    ts: new Date().toISOString(),
    project: context.projectRoot,
    fingerprint: taskFingerprint(context.taskDescription),
    attempt: context.priorAttempts + 1,
    verdict: "needs_clarification",
    failed_dimensions: [],
    task_preview: context.taskDescription.trim().slice(0, 200),
    evidence_source: context.collection.evidenceSource,
    scope: context.collection.scope
      ? {
          rule: context.collection.scope.rule,
          commits: context.collection.scope.commits.length,
          range: context.collection.scope.description,
        }
      : null,
    changed_files: context.collection.files.slice(0, 50).map((file) => file.path),
    warnings: [...context.warnings, ...signals],
    note: "the request states no checkable requirement, so the change was not judged; attempt not counted",
  });
}

/**
 * What the agent is asked to do about it: report the interpretation to the user,
 * then resubmit the same request with the criteria it is working to.
 */
function clarificationGuidance(taskDescription: string, assessment: RequestAssessment): string {
  const trimmed = taskDescription.trim();
  const preview = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
  return [
    "Do not report this task as complete, and do not treat it as a failed review: the change was not judged and no retry was used.",
    `Tell the user in one or two sentences what you took "${preview}" to mean.`,
    `Then resubmit the same request with those acceptance criteria in \`notes\`. To make it judgeable: ${assessment.suggestions.join("; ")}.`,
  ].join(" ");
}

/* ------------------------------------------------------------------ *
 * Failure path
 * ------------------------------------------------------------------ */

interface CommonContext {
  config: VibecheckConfig;
  projectRoot: string;
  stateDir: string;
  fingerprint: string;
  attemptNumber: number;
  collection: ReturnType<typeof collectChangedFiles>;
  conventions: ConventionReference;
  analysis: AnalysisReport;
  testResults: TestResults | null;
  stateChars: number;
  warnings: string[];
  submitted: SubmittedFile[];
  assessment: RequestAssessment;
}

function handleJudgeFailure(error: unknown, context: CommonContext): SubmitResult {
  const jevError =
    error instanceof JevError
      ? error
      : new JevError(
          error instanceof Error ? error.message : String(error),
          "network",
          { retryable: true, cause: error },
        );
  const remediation = remediationFor(jevError);

  log.error("judge failed", { kind: jevError.kind, status: jevError.status, message: jevError.message });

  // The attempt is logged but not counted, so a broken judge cannot exhaust the
  // agent's budget. See `countAttempts`.
  appendEntry(context.stateDir, {
    kind: "review",
    ts: new Date().toISOString(),
    project: context.projectRoot,
    fingerprint: context.fingerprint,
    attempt: context.attemptNumber,
    verdict: "review_unavailable",
    failed_dimensions: [],
    task_preview: "",
    evidence_source: context.collection.evidenceSource,
    judge: {
      provider: resolveJudgeProvider(context.config.judge.provider),
      model: context.config.judge.model,
      latency_ms: 0,
    },
    warnings: [...context.warnings, `${jevError.kind}: ${jevError.message}`],
    note: "review could not be performed; attempt not counted",
  });

  return {
    verdict: "review_unavailable",
    approved: false,
    review_performed: false,
    scores: {},
    diagnostics: {},
    feedback: [],
    attempts_remaining: Math.max(0, context.config.maxRetries - (context.attemptNumber - 1)),
    attempt_number: context.attemptNumber,
    max_retries: context.config.maxRetries,
    summary: `The review could not be performed: ${jevError.message}`,
    next_action: `${remediation} This submission was not judged, so it neither passed nor failed, and it did not use one of your retries.`,
    warnings: [...context.warnings, `${jevError.kind}: ${jevError.message}`],
    hard_gate_failures: [],
    evidence: {
      source: context.collection.evidenceSource,
      base: context.collection.baseDescription,
      changed_files: context.collection.files.map((file) => file.path),
      scope: scopeReport(context.collection.scope),
    },
    judge: {
      // Report the provider that was actually attempted, not the configured
      // `auto` sentinel, so the message names the thing that failed.
      provider: resolveJudgeProvider(context.config.judge.provider),
      model: context.config.judge.model,
      latency_ms: 0,
      caveat: null,
    },
    judge_error: {
      kind: jevError.kind,
      message: jevError.message,
      remediation,
    },
    intent: context.assessment,
    config_used: {
      preset: context.config.preset,
      config_path: null,
      diagnostics: context.config.judge.diagnostics,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function normaliseSubmitted(input: SubmittedFile[] | undefined): SubmittedFile[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((file): file is SubmittedFile => Boolean(file) && typeof file === "object" && typeof file.path === "string")
    .map((file) => ({
      path: file.path,
      ...(typeof file.diff === "string" ? { diff: file.diff } : {}),
      ...(typeof file.content === "string" ? { content: file.content } : {}),
    }));
}

function scoreReport(evaluation: EvaluationResult): Record<string, ScoreReport> {
  const out: Record<string, ScoreReport> = {};
  for (const score of evaluation.scores) {
    out[score.dimension] = {
      score: round(score.score),
      threshold: score.threshold,
      passed: score.passed,
      weight: score.weight,
      kind: score.kind,
      tier: score.tier,
      confidence: score.confidence === null ? null : round(score.confidence),
      level: score.levelLabel,
      reason: score.reason,
    };
  }
  return out;
}

function diagnosticReport(answers: Record<string, JevAnswer>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === "choice") out[id] = answer.choice;
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function scopeReport(
  scope: ReturnType<typeof collectChangedFiles>["scope"],
): SubmitResult["evidence"]["scope"] {
  if (!scope) return null;
  return {
    rule: scope.rule,
    description: scope.description,
    commits: scope.commits.length,
    window_hours: scope.windowHours,
    unreached_claims: scope.unreachedClaims,
  };
}

/** Human-readable verdict, used for the MCP text content. */
export function renderVerdictText(result: SubmitResult): string {
  const lines: string[] = [];
  const headline: Record<Verdict, string> = {
    approved: "APPROVED",
    needs_fixes: "NEEDS FIXES",
    max_retries_exceeded: "MAX RETRIES EXCEEDED",
    review_unavailable: "REVIEW COULD NOT BE PERFORMED",
    needs_clarification: "CLARIFICATION NEEDED",
  };
  lines.push(`## vibe-check: ${headline[result.verdict]}`);
  lines.push("");
  lines.push(result.summary);
  lines.push("");
  lines.push(`Attempt ${result.attempt_number} of ${result.max_retries} — ${result.attempts_remaining} remaining.`);

  if (result.judge.caveat) {
    lines.push("");
    lines.push(`> ${result.judge.caveat}`);
  }

  // Said plainly and early: the difference between "your change failed" and "your
  // request cannot be checked" is the whole point of this verdict.
  if (!result.intent.verifiable) {
    lines.push("");
    lines.push("### The request itself");
    lines.push(
      result.verdict === "needs_clarification"
        ? "This request states nothing checkable, so no verdict was given. The change was not judged and no retry was used."
        : "This request states nothing checkable, so `satisfies_request` is being scored against a request that does not define done. Weigh the other dimensions accordingly.",
    );
    for (const signal of result.intent.signals) lines.push(`- ${signal}`);
    if (result.intent.suggestions.length > 0) {
      lines.push("");
      lines.push("To make it judgeable:");
      for (const suggestion of result.intent.suggestions) lines.push(`- ${suggestion}`);
    }
  }

  if (Object.keys(result.scores).length > 0) {
    lines.push("");
    lines.push("| dimension | score | threshold | result |");
    lines.push("| --- | --- | --- | --- |");
    for (const [dimension, score] of Object.entries(result.scores)) {
      lines.push(
        `| ${dimension} | ${score.score.toFixed(2)} | ${score.threshold.toFixed(2)} | ${score.passed ? "pass" : "FAIL"} |`,
      );
    }
  }

  if (result.hard_gate_failures.length > 0) {
    lines.push("");
    lines.push("### Hard gate failures (not scored - checked directly)");
    for (const failure of result.hard_gate_failures) {
      lines.push(`- **${failure.gate}**: ${failure.message}`);
    }
  }

  if (result.feedback.length > 0) {
    lines.push("");
    lines.push("### What to fix");
    result.feedback.forEach((item, index) => {
      lines.push("");
      lines.push(`**${index + 1}. ${item.title}** (${item.dimension}, score ${item.score.toFixed(2)} vs ${item.threshold.toFixed(2)})`);
      lines.push(item.instruction);
      if (item.evidence.length > 0) {
        lines.push("");
        for (const line of item.evidence) lines.push(`- ${line}`);
      }
      if (item.files.length > 0) {
        lines.push("");
        lines.push(`Files: ${item.files.join(", ")}`);
      }
    });
  }

  if (result.judge_error) {
    lines.push("");
    lines.push(`### Review error (${result.judge_error.kind})`);
    lines.push(result.judge_error.message);
    lines.push("");
    lines.push(result.judge_error.remediation);
  }

  lines.push("");
  lines.push("### Next action");
  lines.push(result.next_action);

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("### Notes");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  lines.push("");
  const judgeSummary =
    result.judge.provider === "not_consulted"
      ? "judge: not consulted (the request was assessed before any judgment)"
      : `judge: ${result.judge.provider} (${result.judge.model})`;
  lines.push(
    `Evidence: ${result.evidence.source === "git" ? `git (${result.evidence.base ?? "working tree"})` : "agent-submitted (not a git repository)"}; ${judgeSummary}; preset: ${result.config_used.preset}.`,
  );
  if (result.evidence.scope) {
    const scope = result.evidence.scope;
    lines.push(
      `Reviewed scope: \`${scope.rule}\`, ${scope.commits} commit(s)${
        scope.window_hours === null ? "" : `, ${scope.window_hours}h window`
      } — ${scope.description}.`,
    );
    if (scope.unreached_claims.length > 0) {
      lines.push(
        `Not reviewed (reported but outside the scope): ${scope.unreached_claims.join(", ")}. Raise \`scope.maxCommits\` or commit the work inside the window to have it judged.`,
      );
    }
  }

  return lines.join("\n");
}
