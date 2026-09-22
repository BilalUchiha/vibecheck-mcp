/**
 * Offline heuristic judge.
 *
 * WHAT THIS IS: a deterministic stand-in for Jev that scores a change set from
 * the measured signals in the review state. It exists so the whole loop -
 * thresholds, feedback, retries, escalation, logging - can be exercised and
 * regression-tested without an API key or a network call.
 *
 * WHAT THIS IS NOT: a review. It cannot read intent, and it will happily pass a
 * change that does not do what was asked. Every verdict it produces carries a
 * caveat that says so, and `get_review_log` records which provider judged.
 *
 * Because its scores come from the same signals the feedback layer uses, fixing
 * a real problem genuinely moves the score - which is what makes it useful for
 * testing the retry path end to end.
 */

import { DIAGNOSTIC_BY_ID, GATE_QUESTIONS } from "../questions.js";
import type { GateDimension, JevAnswer } from "../types.js";
import type { ReviewState } from "../context/state.js";
import type { Judge, JudgeRequest, JudgeResult } from "./client.js";

const CAVEAT =
  "Judged by the built-in offline mock, not by Jev. Its scores are heuristics over static analysis and do not constitute a real review. Set TYPESAFE_API_KEY and judge.provider to \"typesafe\" for genuine verdicts.";

interface Signals {
  changes: number;
  omitted: number;
  addedLines: number;
  removedLines: number;
  newFiles: number;
  casingMismatches: number;
  riskCounts: Record<string, number>;
  hardcodedCounts: Record<string, number>;
  unhandled: number;
  /**
   * Findings that represent a genuinely lost failure: a discarded promise, or an
   * unguarded fallible call in a function that does not rethrow either. An
   * unguarded await inside a function that explicitly rethrows may be a
   * deliberate choice, so it is reported but not counted against the change.
   */
  swallowedFailures: number;
  floatingPromises: number;
  largeFunctions: number;
  testFiles: number;
  assertions: number;
  assertionless: number;
  skipped: number;
  focused: number;
  docsOnly: boolean;
  hasFallibleOps: boolean;
  formattingDivergences: number;
  measuredCasing: string | null;
  newCodeCasing: string | null;
  casingExample: { name: string; actual: string; expected: string } | null;
  largestFunction: { name: string; path: string; lines: number; branches: number } | null;
  firstUnhandled: { path: string; line: number; in: string } | null;
  firstMagicNumber: string | null;
  task: string;
  taskMentionsTests: boolean;
}

/* ------------------------------------------------------------------ *
 * Signal extraction
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countBy(items: unknown[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const value = asRecord(item)[key];
    if (typeof value !== "string") continue;
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function readSignals(state: ReviewState): Signals {
  const analysis = asRecord(state.analysis);
  const tests = asRecord(analysis.tests);
  const totals = asRecord(analysis.totals);
  const measured = asRecord(asRecord(state.repo_style).measured);
  const style = asRecord(analysis.style);

  const risks = asArray(analysis.risk_markers);
  const hardcoded = asArray(analysis.hardcoded_values);
  const unhandled = asArray(analysis.unhandled_async);
  const largeFunctions = asArray(analysis.large_functions);
  const mismatches = asArray(analysis.casing_mismatches);
  const omittedList = asArray(analysis.files_omitted_from_state);

  const floating = unhandled.filter((item) => /promise started/i.test(String(asRecord(item).excerpt ?? "")));
  const allCode = state.changes.map((change) => change.code).join("\n");

  const firstMismatch = asRecord(mismatches[0]);
  const firstLarge = asRecord(largeFunctions[0]);
  const firstUnhandledRecord = asRecord(unhandled[0]);
  const firstMagic = asRecord(hardcoded.find((item) => asRecord(item).kind === "magic-number"));

  const task = state.task ?? "";
  let formattingDivergences = 0;
  for (const key of ["indent", "quotes", "semicolons"] as const) {
    const expected = measured[key];
    const actual = style[key];
    if (typeof expected === "string" && typeof actual === "string" && expected !== actual) {
      formattingDivergences++;
    }
  }

  return {
    changes: state.changes.length,
    omitted: typeof analysis.files_omitted_from_state === "object" ? omittedList.length : 0,
    addedLines: Number(totals.added_lines ?? 0),
    removedLines: Number(totals.removed_lines ?? 0),
    newFiles: asArray(totals.new_files).length,
    casingMismatches: mismatches.length,
    riskCounts: countBy(risks, "kind"),
    hardcodedCounts: countBy(hardcoded, "kind"),
    unhandled: unhandled.length,
    swallowedFailures: unhandled.filter((item) => {
      const record = asRecord(item);
      if (record.kind === "floating_promise") return true;
      return record.enclosing_function_rethrows !== true;
    }).length,
    floatingPromises: floating.length,
    largeFunctions: largeFunctions.length,
    testFiles: asArray(tests.test_files_changed).length,
    assertions: Number(tests.assertions_found ?? 0),
    assertionless: Number(tests.assertionless_test_cases ?? 0),
    skipped: Number(tests.skipped_tests ?? 0),
    focused: Number(tests.focused_tests ?? 0),
    docsOnly: state.changes.length > 0 && state.changes.every((change) => !isCodePath(change.path)),
    hasFallibleOps: /(?:^|\W)(?:await|fetch\(|axios|readFile|writeFile|fs\.|fetch|open\(|requests\.|subprocess|exec\(|query\(|\.get\(|\.post\(|\.put\(|\.delete\()/m.test(
      allCode,
    ),
    formattingDivergences,
    measuredCasing: typeof measured.dominant_casing === "string" ? measured.dominant_casing : null,
    newCodeCasing: typeof style.dominant_casing === "string" ? style.dominant_casing : null,
    casingExample:
      firstMismatch.name !== undefined
        ? {
            name: String(firstMismatch.name),
            actual: String(firstMismatch.actual_style ?? ""),
            expected: String(firstMismatch.expected_style ?? ""),
          }
        : null,
    largestFunction:
      firstLarge.name !== undefined
        ? {
            name: String(firstLarge.name),
            path: String(firstLarge.path ?? ""),
            lines: Number(firstLarge.lines ?? 0),
            branches: Number(firstLarge.branches ?? 0),
          }
        : null,
    firstUnhandled:
      firstUnhandledRecord.path !== undefined
        ? {
            path: String(firstUnhandledRecord.path),
            line: Number(firstUnhandledRecord.line ?? 0),
            in: String(firstUnhandledRecord.in ?? ""),
          }
        : null,
    firstMagicNumber: firstMagic.kind !== undefined ? String(firstMagic.text ?? "") : null,
    task,
    taskMentionsTests: /\btests?|spec|coverage\b/i.test(task),
  };
}

function isCodePath(filePath: string): boolean {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/i.test(filePath);
}

/* ------------------------------------------------------------------ *
 * Dimension scoring
 * ------------------------------------------------------------------ */

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

const RISK_WEIGHT: Record<string, number> = {
  todo: 1.5,
  fixme: 1.5,
  hack: 1.5,
  "ts-ignore": 1.5,
  "eslint-disable": 1.5,
  "skipped-test": 1.5,
  "only-test": 1.5,
  "debugger-statement": 1,
  "loose-any": 0.7,
  "console-log": 0.4,
};

function riskWeight(signals: Signals): number {
  let total = 0;
  for (const [kind, count] of Object.entries(signals.riskCounts)) {
    total += (RISK_WEIGHT[kind] ?? 0.5) * count;
  }
  return total;
}

/** Probability that the dimension is satisfied, 0-1. Higher is better. */
function probabilityFor(dimension: GateDimension, signals: Signals): number {
  switch (dimension) {
    case "satisfies_request": {
      if (signals.changes === 0) return 0.05;
      let p = 0.9;
      p -= Math.min(0.4, (signals.riskCounts.todo ?? 0) * 0.2);
      p -= Math.min(0.25, signals.omitted * 0.12);
      if (signals.docsOnly && signals.addedLines > 0) p -= 0.05;
      return clamp(p, 0.02, 0.97);
    }
    case "scope_appropriate": {
      if (signals.changes === 0) return 0.1;
      let p = 0.88;
      if (signals.changes > 20) p -= 0.3;
      else if (signals.changes > 12) p -= 0.12;
      if (signals.addedLines > 2000) p -= 0.3;
      else if (signals.addedLines > 800) p -= 0.12;
      if (signals.newFiles > 10) p -= 0.15;
      return clamp(p, 0.05, 0.97);
    }
    case "follows_conventions": {
      if (signals.measuredCasing === null) return 0.75; // nothing to compare against
      let p = 0.9 - Math.min(0.6, signals.casingMismatches * 0.09);
      p -= Math.min(0.2, signals.formattingDivergences * 0.08);
      return clamp(p, 0.05, 0.97);
    }
    case "separation_of_concerns": {
      let p = 0.9 - Math.min(0.65, signals.largeFunctions * 0.25);
      return clamp(p, 0.05, 0.97);
    }
    case "introduces_debt": {
      // One clear shortcut should be enough to miss a 0.7 bar, because the
      // whole point of this dimension is to stop "I'll clean it up later" from
      // being submitted as done.
      const penalty =
        0.2 * riskWeight(signals) +
        0.22 * (signals.hardcodedCounts.url ?? 0) +
        0.3 * (signals.hardcodedCounts.secret ?? 0) +
        0.18 * (signals.hardcodedCounts["magic-number"] ?? 0) +
        0.15 * (signals.hardcodedCounts["absolute-path"] ?? 0) +
        0.1 * signals.swallowedFailures;
      return clamp(0.95 - penalty, 0.03, 0.97);
    }
    case "readability":
    case "error_handling_present":
    case "test_coverage_adequate": {
      const level = levelFor(dimension, signals);
      const question = GATE_QUESTIONS[dimension];
      return level / (question.levels - 1);
    }
    default:
      return 0.5;
  }
}

/** Raw level index on the question's own scale. */
function levelFor(dimension: GateDimension, signals: Signals): number {
  switch (dimension) {
    case "readability": {
      if (signals.changes === 0) return 0;
      let level = 3;
      if (signals.largeFunctions > 0) level -= 1;
      if ((signals.hardcodedCounts["magic-number"] ?? 0) >= 2) level -= 1;
      if ((signals.riskCounts["console-log"] ?? 0) + (signals.riskCounts["debugger-statement"] ?? 0) >= 2) level -= 1;
      if ((signals.riskCounts["loose-any"] ?? 0) >= 3) level -= 1;
      return clamp(level, 0, 3);
    }
    case "error_handling_present": {
      if (!signals.hasFallibleOps) return 3; // nothing to handle
      // `swallowedFailures` excludes findings where the enclosing function
      // rethrows, because surfacing a failure to the caller is handling it.
      if (signals.swallowedFailures === 0) return 3;
      if (signals.swallowedFailures === 1) return 2;
      if (signals.swallowedFailures <= 3) return 1;
      return 0;
    }

    case "test_coverage_adequate": {
      if (signals.docsOnly) return 3; // no testable behaviour
      if (signals.testFiles === 0) return signals.taskMentionsTests ? 0 : 1;
      if (signals.assertions === 0 || signals.assertionless > 0) return 1;
      if (signals.skipped > 0 || signals.focused > 0) return 1;
      return 2;
    }
    default:
      return 2;
  }
}

/* ------------------------------------------------------------------ *
 * Diagnostic selection
 * ------------------------------------------------------------------ */

function diagnosticFor(id: string, signals: Signals): string {
  const options = Object.keys(DIAGNOSTIC_BY_ID[id]?.criteria ?? {});
  const fallback = options[0] ?? "none";
  const pick = (candidate: string): string => (options.includes(candidate) ? candidate : fallback);

  switch (id) {
    case "diagnostic_request_gap": {
      if ((signals.riskCounts.todo ?? 0) > 0) return pick("stub_or_placeholder");
      if (signals.omitted > 0) return pick("partial_implementation");
      if (signals.changes === 0) return pick("missing_requirement");
      return pick("none");
    }
    case "diagnostic_scope_direction": {
      if (signals.changes > 20 || signals.addedLines > 2000) return pick("over_delivered");
      if (signals.omitted > 0) return pick("under_delivered");
      return pick("about_right");
    }
    case "diagnostic_convention_gap": {
      if (signals.casingMismatches > 0) return pick("naming_casing");
      if (signals.formattingDivergences > 0) return pick("formatting");
      return pick("none");
    }
    case "diagnostic_separation_gap": {
      if (signals.largeFunctions > 0) return pick("god_function");
      return pick("none");
    }
    case "diagnostic_debt_kind": {
      const priority = [
        "secret",
        "todo",
        "fixme",
        "hack",
        "skipped-test",
        "only-test",
        "ts-ignore",
        "eslint-disable",
        "debugger-statement",
        "console-log",
      ];
      if ((signals.hardcodedCounts.secret ?? 0) > 0) return pick("hardcoded_value_that_should_be_config");
      for (const kind of priority) {
        if ((signals.riskCounts[kind] ?? 0) === 0) continue;
        if (kind === "todo" || kind === "fixme") return pick("leftover_todo");
        if (kind === "hack") return pick("hacky_workaround");
        if (kind === "skipped-test" || kind === "only-test") return pick("weakened_test_or_type_check");
        if (kind === "ts-ignore" || kind === "eslint-disable") return pick("weakened_test_or_type_check");
        if (kind === "console-log") return pick("debug_output_left_behind");
        if (kind === "debugger-statement") return pick("debug_output_left_behind");
      }
      if ((signals.hardcodedCounts.url ?? 0) + (signals.hardcodedCounts["magic-number"] ?? 0) > 0) {
        return pick("hardcoded_value_that_should_be_config");
      }
      if (signals.unhandled > 0) return pick("swallowed_error");
      return pick("none");
    }
    case "diagnostic_readability_gap": {
      if (signals.largeFunctions > 0) return pick("overly_long_function");
      if ((signals.hardcodedCounts["magic-number"] ?? 0) > 0) return pick("unexplained_constants_or_logic");
      if ((signals.riskCounts["console-log"] ?? 0) > 0) return pick("misleading_comments");
      return pick("none");
    }
    case "diagnostic_error_handling_gap": {
      if (!signals.hasFallibleOps) return pick("not_applicable");
      if (signals.swallowedFailures === 0) return pick("none");
      if (signals.floatingPromises > 0) return pick("unhandled_rejection");
      return pick("missing_try_catch");
    }
    case "diagnostic_test_gap": {
      if (signals.docsOnly) return pick("not_applicable");
      if (signals.testFiles === 0) return pick("no_tests_at_all");
      if (signals.assertions === 0 || signals.assertionless > 0) return pick("trivial_or_assertionless_tests");
      if (signals.skipped > 0 || signals.focused > 0) return pick("skipped_or_disabled_tests");
      return pick("missing_edge_cases");
    }
    default:
      return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * Judge implementation
 * ------------------------------------------------------------------ */

export class MockJudge implements Judge {
  readonly provider = "mock" as const;

  async decide(request: JudgeRequest): Promise<JudgeResult> {
    const startedAt = Date.now();
    const signals = readSignals(request.state);
    const answers: Record<string, JevAnswer> = {};

    for (const [id, spec] of Object.entries(request.questions)) {
      answers[id] = this.answer(id, spec.type, signals);
    }

    return {
      provider: this.provider,
      model: "vibecheck-offline-mock-1",
      answers,
      // Rough proxy for the token cost a real call would incur, so logs are comparable.
      usage: { input_tokens: Math.round(JSON.stringify(request.state).length / 4), output_tokens: 0 },
      latencyMs: Date.now() - startedAt,
      caveat: CAVEAT,
    };
  }

  private answer(id: string, type: "noul" | "choice" | "score", signals: Signals): JevAnswer {
    const gate = GATE_QUESTIONS[id as GateDimension];

    if (type === "choice") {
      const chosen = diagnosticFor(id, signals);
      const options = Object.keys(DIAGNOSTIC_BY_ID[id]?.criteria ?? { [chosen]: "" });
      const probabilities: Record<string, number> = {};
      const otherShare = options.length > 1 ? 0.15 / (options.length - 1) : 0;
      for (const option of options) probabilities[option] = option === chosen ? 0.85 : otherShare;
      return { type: "choice", choice: chosen, probabilities, confidence: 0.8 };
    }

    if (gate && type === "score") {
      const level = levelFor(gate.dimension, signals);
      const legend: Record<string, string> = {};
      gate.levelDescriptions.forEach((description, index) => {
        legend[String(index)] = description;
      });
      const probabilities: Record<string, number> = {};
      for (let index = 0; index < gate.levels; index++) probabilities[String(index)] = index === level ? 0.8 : 0.2 / (gate.levels - 1);
      return { type: "score", score: level, legend, probabilities, confidence: 0.7 };
    }

    if (gate) {
      return { type: "noul", noul: probabilityFor(gate.dimension, signals) };
    }

    return { type: "noul", noul: 0.5 };
  }
}

/** Exposed for tests and for `get_review_log` explanations. */
export const MOCK_CAVEAT = CAVEAT;
export { readSignals as extractSignals };
