/**
 * Verdict evaluation.
 *
 * Two independent mechanisms decide the verdict:
 *
 *  - Scored dimensions, where Jev's calibrated probability is compared against a
 *    per-project threshold.
 *  - Hard gates, which are *facts* rather than judgments: failing tests, a
 *    credential in the diff, or a file the agent claimed to change but did not.
 *    A model's opinion is not required to know that tests are red, and asking it
 *    would only add a way for the gate to be wrong.
 */

import { GATE_QUESTIONS, DIAGNOSTIC_BY_ID, levelLabelFor, normaliseScore } from "../questions.js";
import { GATE_DIMENSIONS } from "../types.js";
import type { VibecheckConfig } from "../config.js";
import type { AnalysisReport, DimensionScore, GateDimension, HardGateFailure, JevAnswer, TestResults } from "../types.js";
import type { ReviewState } from "../context/state.js";
import type { Mismatch } from "../context/collect.js";

export interface EvaluationInput {
  config: VibecheckConfig;
  answers: Record<string, JevAnswer>;
  state: ReviewState;
  analysis: AnalysisReport;
  testResults: TestResults | null;
  mismatch: Mismatch | null;
  /** Diagnostics can be disabled, in which case `reason` stays null. */
  diagnosticsEnabled: boolean;
}

export interface EvaluationResult {
  scores: DimensionScore[];
  failed: DimensionScore[];
  hardGateFailures: HardGateFailure[];
  /** Dimensions that were enabled but that the judge did not answer. */
  unanswered: GateDimension[];
  wouldApprove: boolean;
}

export function evaluate(input: EvaluationInput): EvaluationResult {
  const scores: DimensionScore[] = [];
  const unanswered: GateDimension[] = [];

  for (const dimension of GATE_DIMENSIONS) {
    const questionConfig = input.config.questions[dimension];
    if (!questionConfig?.enabled) continue;

    const question = GATE_QUESTIONS[dimension];
    const answer = input.answers[dimension];
    if (!answer) {
      unanswered.push(dimension);
      continue;
    }

    const score = scoreOf(dimension, answer);
    if (score === null) {
      unanswered.push(dimension);
      continue;
    }

    const confidence = "confidence" in answer && typeof answer.confidence === "number" ? answer.confidence : null;
    const reason = reasonFor(dimension, input.answers, input.diagnosticsEnabled);

    scores.push({
      dimension,
      label: question.label,
      tier: question.tier,
      kind: question.kind,
      score,
      threshold: questionConfig.threshold,
      passed: score >= questionConfig.threshold,
      weight: questionConfig.weight,
      confidence,
      levelLabel: question.kind === "score" ? levelLabelFor(question, score) : null,
      reason,
    });
  }

  const failed = scores
    .filter((score) => !score.passed)
    .sort((a, b) => severityOf(b) - severityOf(a));

  const hardGateFailures = evaluateHardGates(input);

  return {
    scores,
    failed,
    hardGateFailures,
    unanswered,
    wouldApprove: failed.length === 0 && hardGateFailures.length === 0,
  };
}

/**
 * Severity orders the fix list: how far below the bar, scaled by how much the
 * dimension matters. Weight is deliberately used only for ordering and never for
 * gating, so raising a dimension's weight cannot let a genuine failure through.
 */
export function severityOf(score: DimensionScore): number {
  return score.weight * (score.threshold - score.score);
}

/**
 * Reduce a typed answer to a 0-1 value where 1 is always good. `noul` needs no
 * conversion; a `score` is the probability-weighted mean of its level indices,
 * so it is divided by (levels - 1). The raw score is clamped to the declared
 * scale first, in case a model returns a position outside it.
 */
function scoreOf(dimension: GateDimension, answer: JevAnswer): number | null {
  const question = GATE_QUESTIONS[dimension];

  if (question.kind === "noul") {
    if (answer.type !== "noul" || typeof answer.noul !== "number") return null;
    return clamp01(answer.noul);
  }

  if (answer.type !== "score" || typeof answer.score !== "number") return null;
  if (!Number.isFinite(answer.score)) return null;
  const maximum = Math.max(question.levels - 1, 1);
  const bounded = Math.min(Math.max(answer.score, 0), maximum);
  return normaliseScore(question, bounded);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The diagnostic option *key*, such as `naming_casing`.
 *
 * This must be the key and not the human label: the feedback layer branches on
 * it to choose which instruction template to render, and `reasonLabel()` turns
 * it into prose when prose is wanted. Returning the label here silently
 * disabled every reason-specific instruction, leaving only generic advice -
 * exactly the failure mode this tool exists to avoid.
 */
function reasonFor(
  dimension: GateDimension,
  answers: Record<string, JevAnswer>,
  diagnosticsEnabled: boolean,
): string | null {
  if (!diagnosticsEnabled) return null;
  const question = GATE_QUESTIONS[dimension];
  const answer = answers[question.diagnosticId];
  if (!answer || answer.type !== "choice") return null;
  const diagnostic = DIAGNOSTIC_BY_ID[question.diagnosticId];
  if (!diagnostic) return null;
  if (!(answer.choice in diagnostic.criteria)) return null;
  // `none` / `not_applicable` mean the diagnostic found nothing to report.
  if (answer.choice === "none" || answer.choice === "not_applicable") return null;
  return answer.choice;
}

/** Human phrase for a diagnostic option key, for use inside instructions. */
export function reasonLabel(dimension: string, reason: string | null): string | null {
  if (!reason) return null;
  const question = GATE_QUESTIONS[dimension as GateDimension];
  if (!question) return reason;
  const diagnostic = DIAGNOSTIC_BY_ID[question.diagnosticId];
  return diagnostic?.labels[reason] ?? reason;
}

function evaluateHardGates(input: EvaluationInput): HardGateFailure[] {
  const failures: HardGateFailure[] = [];
  const { config, testResults, mismatch, analysis } = input;

  if (config.hardGates.failingTests && testResults && testResults.passed === false) {
    failures.push({
      gate: "failing_tests",
      message: "The supplied test run reports failures. A change cannot be approved while its own tests are red.",
      evidence: [
        testResults.summaryLine ?? "test output reported failures",
        ...firstLines(testResults.raw, 6),
      ],
    });
  }

  if (config.hardGates.committedSecret) {
    const secrets = analysis.hardcoded.filter((value) => value.kind === "secret");
    if (secrets.length > 0) {
      failures.push({
        gate: "committed_secret",
        message:
          "A value that looks like a credential appears in the change. This is checked deterministically rather than scored, and it must be removed before the change can be approved.",
        evidence: secrets.slice(0, 5).map((secret) => `${secret.path}:${secret.line} — ${secret.text}`),
      });
    }
  }

  if (config.hardGates.submissionMismatch && mismatch && mismatch.claimedButUnchanged.length > 0) {
    failures.push({
      gate: "submission_mismatch",
      message:
        "The change set claimed files that git does not report as changed. The review was performed against git's view of the repository, so either the claim or the change is wrong.",
      evidence: mismatch.claimedButUnchanged.slice(0, 10).map((file) => `claimed but unchanged: ${file}`),
    });
  }

  return failures;
}

function firstLines(value: string, count: number): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, count);
}
