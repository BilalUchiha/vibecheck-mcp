/**
 * Review state construction.
 *
 * The state is what Jev sees. Two rules govern it:
 *
 *  - Send only what the questions need. TypeSafe's own guidance is that accuracy
 *    degrades as the state fills with unrelated content, so the budget is a
 *    quality control, not just a cost control.
 *  - Be explicit about the limits of the evidence. If a file had no diff, its
 *    findings cover the whole file rather than the change, and the state says so
 *    instead of letting the model assume otherwise.
 *
 * Field names here are load-bearing: the question instructions in
 * `src/questions.ts` reference them with backticked paths, so renaming one
 * without updating the other silently degrades every judgment.
 */

import { describeStyle, truncate } from "./analyze.js";
import { HUMAN_CASING } from "./lang.js";
import type { ConventionReference } from "./conventions.js";
import type { Mismatch } from "./collect.js";
import type { AnalysisReport, ChangedFile, TestResults } from "../types.js";
import type { VibecheckConfig } from "../config.js";

export interface StateChange {
  path: string;
  status: string;
  added: number;
  removed: number;
  /** True when `code` is the whole file rather than just the diff. */
  full_file: boolean;
  code: string;
}

export interface ReviewState {
  task: string;
  change_summary: string;
  changes: StateChange[];
  changes_omitted: number;
  changes_are_empty: boolean;
  repo_style: Record<string, unknown>;
  analysis: Record<string, unknown>;
  tests: unknown;
  evidence: Record<string, unknown>;
}

export interface StateBuildResult {
  state: ReviewState;
  serialised: string;
  chars: number;
  omittedFiles: string[];
  truncatedFiles: string[];
  warnings: string[];
}

const CAPS = {
  casingMismatches: 25,
  riskMarkers: 30,
  hardcoded: 25,
  unhandledAsync: 20,
  godFunctions: 10,
  referenceFiles: 4,
};

export interface StateInput {
  taskDescription: string;
  files: ChangedFile[];
  analysis: AnalysisReport;
  conventions: ConventionReference;
  testResults: TestResults | null;
  evidenceSource: "git" | "submitted";
  baseDescription: string | null;
  mismatch: Mismatch | null;
  config: VibecheckConfig;
  /** Extra notes from the agent, e.g. what it ran. */
  notes?: string | undefined;
}

export function buildReviewState(input: StateInput): StateBuildResult {
  const warnings: string[] = [];
  const budget = input.config.budget;

  const analysis = digestAnalysis(input.analysis, input.config);
  const repoStyle = digestConventions(input.conventions);
  const tests = input.testResults
    ? {
        source: "agent-supplied test run",
        passed: input.testResults.passed,
        failures: input.testResults.failures,
        framework: input.testResults.framework,
        summary_line: input.testResults.summaryLine,
        output_tail: tailOf(input.testResults.raw, 4_000),
      }
    : null;

  const evidence = {
    source: input.evidenceSource,
    base: input.baseDescription,
    note:
      input.evidenceSource === "git"
        ? "The change set was produced by running git in the repository, not from the agent's description of it."
        : "project_root is not a git repository, so the change set is the agent's own report and may be incomplete.",
    submitted_but_unchanged: input.mismatch?.claimedButUnchanged ?? [],
    changed_but_not_submitted: input.mismatch?.changedButUnclaimed ?? [],
  };

  const state: ReviewState = {
    task: input.taskDescription,
    // Stated explicitly so an empty change set is never mistaken for a
    // truncation artefact by the model reading the state.
    change_summary: input.files.length === 0 ? "No files were reported as changed by this task." : summarise(input.analysis),
    changes: [],
    changes_omitted: 0,
    changes_are_empty: input.files.length === 0,
    repo_style: repoStyle,
    analysis,
    tests,
    evidence,
  };

  // Serialise progressively so the budget is enforced against the real payload
  // rather than an estimate.
  const fixedChars = JSON.stringify(state).length;
  let remaining = budget.maxStateChars - fixedChars;
  const omitted: string[] = [];
  const truncated: string[] = [];

  const candidates = input.files.filter((file) => file.status !== "deleted").slice(0, budget.maxChangedFiles);
  const skippedByCount = input.files.filter((file) => file.status !== "deleted").length - candidates.length;
  if (skippedByCount > 0) {
    warnings.push(`${skippedByCount} changed file(s) were not included: the file cap is ${budget.maxChangedFiles}`);
    omitted.push(...input.files.slice(budget.maxChangedFiles).map((file) => file.path));
  }

  for (const file of candidates) {
    const prepared = prepareCode(file, budget.maxCharsPerFile);
    const entry: StateChange = {
      path: file.path,
      status: file.status,
      added: file.added,
      removed: file.removed,
      full_file: prepared.fullFile,
      code: prepared.code,
    };
    const cost = JSON.stringify(entry).length + 1;
    if (cost > remaining) {
      // Do not silently drop the tail of a large change set: naming the omitted
      // files lets the model (and the user) see the judgment is partial.
      omitted.push(file.path);
      continue;
    }
    if (prepared.truncated) truncated.push(file.path);
    state.changes.push(entry);
    remaining -= cost;
  }

  if (truncated.length > 0) {
    warnings.push(
      `${truncated.length} file(s) were truncated to ${budget.maxCharsPerFile} characters; the change set shown is partial`,
    );
  }
  if (omitted.length > 0) {
    warnings.push(`${omitted.length} changed file(s) were omitted from the review state for budget reasons`);
  }

  state.changes_omitted = omitted.length;
  if (omitted.length > 0) {
    (state.analysis as Record<string, unknown>).files_omitted_from_state = omitted.slice(0, 40);
  }

  // Convention excerpts come last: they are supporting context, and seeing the
  // change itself matters more than a style sample of equal size.
  {
    const referenced: { path: string; code: string }[] = [];
    for (const sample of input.conventions.samples.slice(0, CAPS.referenceFiles)) {
      const entry = { path: sample.path, code: truncate(sample.excerpt, 1_200) };
      const cost = JSON.stringify(entry).length + 1;
      if (cost > remaining) break;
      referenced.push(entry);
      remaining -= cost;
    }
    if (referenced.length > 0) state.repo_style.reference_files = referenced;
  }

  if (input.notes) {
    const cost = input.notes.length + 20;
    if (cost <= remaining) {
      state.evidence.agent_notes = truncate(input.notes, 1_500);
    }
  }

  const serialised = JSON.stringify(state);
  return {
    state,
    serialised,
    chars: serialised.length,
    omittedFiles: omitted,
    truncatedFiles: truncated,
    warnings,
  };
}

/**
 * Prefer the whole file when it fits: judging readability or separation of
 * concerns from a three-line-context hunk invites the model to guess at the
 * surrounding code. Large files fall back to the diff.
 */
function prepareCode(file: ChangedFile, maxChars: number): { code: string; fullFile: boolean; truncated: boolean } {
  const content = file.content ?? "";
  const diff = file.diff ?? "";

  if (content && content.length <= maxChars) {
    return { code: content, fullFile: true, truncated: false };
  }
  if (diff) {
    return { code: truncate(diff, maxChars), fullFile: false, truncated: diff.length > maxChars };
  }
  if (content) {
    return { code: truncate(content, maxChars), fullFile: true, truncated: content.length > maxChars };
  }
  return { code: "", fullFile: false, truncated: false };
}

function summarise(analysis: AnalysisReport): string {
  const totals = analysis.totals;
  const languages = totals.languages.length > 0 ? totals.languages.join(", ") : "no supported source files";
  const parts = [
    `${totals.filesChanged} file(s) changed, +${totals.added}/-${totals.removed} lines`,
    `languages: ${languages}`,
  ];
  if (totals.newFiles.length > 0) parts.push(`new: ${totals.newFiles.slice(0, 10).join(", ")}`);
  if (totals.deletedFiles.length > 0) parts.push(`deleted: ${totals.deletedFiles.slice(0, 10).join(", ")}`);
  return parts.join("; ");
}

function digestAnalysis(analysis: AnalysisReport, config: VibecheckConfig): Record<string, unknown> {
  const newCode = analysis.newCode;
  return {
    note: "All lists below were produced by static analysis of the change set. Risk markers, hardcoded values and unhandled async entries are reported for added lines where a diff was available, and for the whole file otherwise. This analysis is heuristic: treat the entries as evidence to weigh, not as proof.",
    totals: {
      files_changed: analysis.totals.filesChanged,
      added_lines: analysis.totals.added,
      removed_lines: analysis.totals.removed,
      new_files: analysis.totals.newFiles,
      deleted_files: analysis.totals.deletedFiles,
    },
    style: {
      summary: describeStyle(newCode),
      dominant_casing: newCode.dominantCasing ? HUMAN_CASING[newCode.dominantCasing] : null,
      casing_consistency: Number(newCode.casingConsistency.toFixed(2)),
      indent: newCode.indent,
      quotes: newCode.quoteStyle,
      semicolons: newCode.semicolons,
    },
    casing_mismatches: analysis.casingViolations.slice(0, CAPS.casingMismatches).map((violation) => ({
      path: violation.path,
      line: violation.line,
      name: violation.name,
      actual_style: violation.actual,
      expected_style: violation.expected,
    })),
    risk_markers: analysis.risks.slice(0, CAPS.riskMarkers).map((risk) => ({
      kind: risk.kind,
      path: risk.path,
      line: risk.line,
      text: risk.text,
    })),
    hardcoded_values: analysis.hardcoded.slice(0, CAPS.hardcoded).map((value) => ({
      kind: value.kind,
      path: value.path,
      line: value.line,
      text: value.redacted ? "[redacted]" : value.text,
    })),
    unhandled_async: analysis.unhandledAsync.slice(0, CAPS.unhandledAsync).map((item) => ({
      path: item.path,
      line: item.line,
      in: item.container,
      kind: item.kind,
      enclosing_function_rethrows: item.propagates,
      excerpt: item.excerpt,
    })),
    large_functions: analysis.godFunctions.slice(0, CAPS.godFunctions).map((fn) => ({
      path: fn.path,
      name: fn.name,
      line: fn.startLine,
      lines: fn.length,
      branches: fn.branches,
    })),
    tests: {
      test_files_changed: analysis.tests.testFilesChanged,
      assertions_found: analysis.tests.assertions,
      assertionless_test_cases: analysis.tests.assertionlessTests,
      skipped_tests: analysis.tests.skippedTests,
      focused_tests: analysis.tests.onlyTests,
      framework: analysis.tests.framework,
      source_files_changed_with_tests_in_the_change: analysis.tests.sourceFilesWithoutTests.length === 0,
    },
    judge_config: {
      diagnostics_enabled: config.judge.diagnostics,
    },
  };
}

function digestConventions(conventions: ConventionReference): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (conventions.source === "off") {
    out.note = "Convention sampling is disabled for this project; judge conventions against general good practice only.";
    return out;
  }
  out.source = conventions.source === "style_guide" ? "an explicit style guide plus sampled repository files" : "files sampled from this repository";
  out.summary = conventions.summary;
  if (conventions.baseline) {
    const baseline = conventions.baseline;
    out.measured = {
      dominant_casing: baseline.dominantCasing ? HUMAN_CASING[baseline.dominantCasing] : null,
      casing_share: Number(baseline.casingConsistency.toFixed(2)),
      declarations_sampled: baseline.identifiers,
      indent: baseline.indent,
      quotes: baseline.quoteStyle,
      semicolons: baseline.semicolons,
    };
    out.naming_statements = namingStatements(conventions.baseline);
  }
  if (conventions.styleGuide) {
    out.style_guide = truncate(conventions.styleGuide, 3_000);
    out.style_guide_note = `Taken from ${conventions.styleGuidePath}. It takes precedence over the sampled profile where the two disagree.`;
  }
  return out;
}

/**
 * Turn measured casing shares into explicit statements, so the convention
 * judgment does not depend on the model inferring a convention from counts.
 */
function namingStatements(baseline: ConventionReference["baseline"]): string[] {
  if (!baseline?.dominantCasing) return [];
  const statements: string[] = [];
  const share = Math.round(baseline.casingConsistency * 100);
  statements.push(
    `Functions, methods and variables in this repository are overwhelmingly ${HUMAN_CASING[baseline.dominantCasing]}: ${share}% of ${baseline.identifiers} sampled declarations use it.`,
  );
  const pascalShare = baseline.identifiers > 0 ? baseline.casing.PascalCase / baseline.identifiers : 0;
  if (pascalShare > 0.05) {
    statements.push("Classes and types are PascalCase, which is expected in this stack and is not a divergence.");
  }
  const screamingShare = baseline.identifiers > 0 ? baseline.casing.SCREAMING_SNAKE_CASE / baseline.identifiers : 0;
  if (screamingShare > 0.02) {
    statements.push("Module-level constants are SCREAMING_SNAKE_CASE, which is expected here and is not a divergence.");
  }
  return statements;
}

function tailOf(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - max)}`;
}

