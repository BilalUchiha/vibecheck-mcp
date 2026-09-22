/**
 * Feedback translation.
 *
 * This is the part of the tool that determines whether it is useful. Jev returns
 * a calibrated probability and nothing else - it cannot explain itself, by
 * design - so every sentence here is constructed locally from measured evidence.
 *
 * The rule the renderers follow: never state anything that was not measured.
 * "error_handling_present is 0.4" is useless; "the call in `fetchData()`
 * (src/api.ts:42) has no failure handling" is actionable. Where a heuristic
 * cannot support a specific claim, the renderer says what it does know and names
 * the file to look at, rather than inventing a defect.
 */

import { extractDeclarations, HUMAN_CASING, isTestFile, linesOf, stripCode } from "../context/lang.js";
import { EMPTY_CATCH, NETWORK_CALL, UNTRUSTED_INPUT, identifierWords } from "../context/patterns.js";
import { MAX_FUNCTION_LINES } from "../context/analyze.js";
import { describeStyle } from "../context/analyze.js";
import { GATE_QUESTIONS } from "../questions.js";
import { reasonLabel } from "./evaluate.js";
import type { CasingStyle, ChangedFile, DimensionScore, FeedbackItem, HardGateFailure } from "../types.js";
import type { AnalysisReport } from "../types.js";
import type { ConventionReference } from "../context/conventions.js";
import type { TestResults } from "../types.js";
import type { VibecheckConfig } from "../config.js";

export interface FeedbackInput {
  scores: DimensionScore[];
  failed: DimensionScore[];
  hardGateFailures: HardGateFailure[];
  analysis: AnalysisReport;
  files: ChangedFile[];
  conventions: ConventionReference;
  testResults: TestResults | null;
  config: VibecheckConfig;
  taskDescription: string;
}

const MAX_EVIDENCE_PER_ITEM = 8;

export function buildFeedback(input: FeedbackInput): FeedbackItem[] {
  const items: FeedbackItem[] = [];

  for (const failure of input.hardGateFailures) {
    items.push(hardGateFeedback(failure));
  }

  for (const score of input.failed) {
    items.push(renderDimension(score, input));
  }

  // Hard gates are non-negotiable and must appear first regardless of weight.
  return items.sort((a, b) => b.severity - a.severity);
}

function hardGateFeedback(failure: HardGateFailure): FeedbackItem {
  const titles: Record<string, string> = {
    failing_tests: "Tests are failing",
    committed_secret: "A credential appears in the change",
    submission_mismatch: "The change set does not match the repository",
  };
  const instructions: Record<string, string> = {
    failing_tests:
      "Fix the failing tests before resubmitting. This is checked directly from the test output rather than scored by a model.",
    committed_secret:
      "Remove the credential from the code and load it from the environment or a secret store instead. If the value was ever committed, it must also be rotated, since removal alone does not undo the exposure.",
    submission_mismatch:
      "Submit the change set that git actually reports. Either the file was never changed, or the change was lost - re-check the working tree before resubmitting.",
  };

  return {
    dimension: `hard_gate:${failure.gate}`,
    title: titles[failure.gate] ?? failure.gate,
    score: 0,
    threshold: 1,
    // Above any weighted dimension so this cannot be deprioritised.
    severity: 1_000,
    instruction: instructions[failure.gate] ?? failure.message,
    evidence: failure.evidence.slice(0, MAX_EVIDENCE_PER_ITEM),
    files: extractFiles(failure.evidence),
  };
}

/* ------------------------------------------------------------------ *
 * Per-dimension rendering
 * ------------------------------------------------------------------ */

function renderDimension(score: DimensionScore, input: FeedbackInput): FeedbackItem {
  const base: Omit<FeedbackItem, "title" | "instruction" | "evidence" | "files"> = {
    dimension: score.dimension,
    score: score.score,
    threshold: score.threshold,
    severity: severity(score),
  };
  const rendered = dispatch(score, input);
  const files = rendered.files.length > 0 ? rendered.files : extractFiles(rendered.evidence);

  return {
    ...base,
    title: rendered.title,
    instruction: rendered.instruction,
    // Renderers routinely cite the same reference file from several angles;
    // de-duplicating keeps the fix list short enough to act on.
    evidence: [...new Set(rendered.evidence)].slice(0, MAX_EVIDENCE_PER_ITEM),
    files: [...new Set(files)].slice(0, 12),
  };
}

interface Rendered {
  title: string;
  instruction: string;
  evidence: string[];
  files: string[];
}

function severity(score: DimensionScore): number {
  return Math.round(score.weight * (score.threshold - score.score) * 100) / 100;
}

function dispatch(score: DimensionScore, input: FeedbackInput): Rendered {
  switch (score.dimension) {
    case "satisfies_request":
      return requestFeedback(score, input);
    case "scope_appropriate":
      return scopeFeedback(score, input);
    case "follows_conventions":
      return conventionFeedback(score, input);
    case "separation_of_concerns":
      return separationFeedback(score, input);
    case "introduces_debt":
      return debtFeedback(score, input);
    case "readability":
      return readabilityFeedback(score, input);
    case "error_handling_present":
      return errorHandlingFeedback(score, input);
    case "test_coverage_adequate":
      return testFeedback(score, input);
    default:
      return {
        title: `Review dimension failed: ${score.dimension}`,
        instruction: `The judge scored ${score.dimension} at ${score.score.toFixed(2)}, below the ${score.threshold.toFixed(2)} threshold. Review the changed files against the original request and address what the score is reacting to.`,
        evidence: defaultEvidence(input),
        files: input.files.map((file) => file.path),
      };
  }
}

/* ---------------- Intent ---------------- */

function requestFeedback(score: DimensionScore, input: FeedbackInput): Rendered {
  const stubs = input.analysis.risks.filter((risk) => risk.kind === "todo" || risk.kind === "fixme");
  const checklist = taskChecklist(input.taskDescription);

  switch (score.reason) {
    case "stub_or_placeholder":
      return {
        title: "The requested behaviour is still a placeholder",
        instruction:
          "Replace the placeholder with the real implementation. The change contains markers that suggest work was deferred rather than finished: remove each one only by implementing what it describes.",
        evidence: stubs.length > 0
          ? stubs.map((stub) => `${stub.path}:${stub.line} — ${stub.text}`)
          : ["the judge identified the delivered behaviour as a stub or placeholder"],
        files: stubs.map((stub) => stub.path),
      };

    case "partial_implementation":
    case "missing_requirement":
      return {
        title: "Part of the request was not implemented",
        instruction:
          "Go back to the original request and implement every requirement. The change appears complete for the parts it covers, but something that was asked for is missing or unfinished.",
        evidence: checklist,
        files: input.files.map((file) => file.path),
      };

    case "adjacent_work":
      return {
        title: "The change is adjacent to the request, not an answer to it",
        instruction:
          "The work touches the right area but does not deliver the behaviour that was asked for. Re-read the request and confirm the specific outcome it names now happens end to end, not just that related code changed.",
        evidence: [...checklist, ...defaultEvidence(input)],
        files: input.files.map((file) => file.path),
      };

    case "wrong_interface":
      return {
        title: "The behaviour is exposed differently from what was asked for",
        instruction:
          "Match the interface the request described: the same name, arguments and return shape. Check how the surrounding code calls it, and update the callers if the interface changed.",
        evidence: [
          ...checklist,
          ...declarationNamesIn(input.files).slice(0, 4),
        ],
        files: input.files.map((file) => file.path),
      };

    case "extra_unrequested_work":
      return {
        title: "The request is satisfied but extra behaviour was added",
        instruction:
          "Keep the part that answers the request and remove the additional behaviour the request did not ask for, or confirm it is genuinely wanted before resubmitting.",
        evidence: unrelatedEvidence(input),
        files: input.files.map((file) => file.path),
      };

    default:
      return {
        title: "The result does not clearly satisfy the request",
        instruction:
          `The judge scored the request as ${describe(score)} not fully satisfied. Verify each requirement below is implemented and observable, then resubmit with the specific evidence that shows it.`,
        evidence: [...checklist, ...defaultEvidence(input)],
        files: input.files.map((file) => file.path),
      };
  }
}

function taskChecklist(taskDescription: string): string[] {
  const statements = taskDescription
    .split(/(?<=[.;\n])\s+|\n+/)
    .map((line) => line.replace(/^[-*•\d.\s]+/, "").trim())
    .filter((line) => line.length > 12)
    .slice(0, 8);
  return statements.length > 0
    ? statements.map((statement) => `confirm this is implemented: ${truncate(statement, 160)}`)
    : [`re-read the original request and confirm it end to end: ${truncate(taskDescription.trim(), 200)}`];
}

/* ---------------- Scope ---------------- */

function scopeFeedback(score: DimensionScore, input: FeedbackInput): Rendered {
  const unrelated = unrelatedEvidence(input);
  const totals = input.analysis.totals;

  switch (score.reason) {
    case "under_delivered":
      return {
        title: "The change does less than the request asked for",
        instruction:
          "Complete the outstanding parts of the request. The scope is smaller than what was asked, so identify what is missing and implement it rather than resubmitting.",
        evidence: [
          `change size: ${totals.filesChanged} file(s), +${totals.added}/-${totals.removed} lines`,
          ...taskChecklist(input.taskDescription).slice(0, 4),
        ],
        files: input.files.map((file) => file.path),
      };

    case "over_delivered":
      return {
        title: "The change goes well beyond the request",
        instruction:
          "Reduce the change to what the request needs. Unrequested refactors, extra features and new dependencies make the change harder to review and to revert; move them to a separate change or drop them.",
        evidence: unrelated.length > 0
          ? unrelated
          : [`change size: ${totals.filesChanged} file(s), +${totals.added}/-${totals.removed} lines, which is large for the request`],
        files: input.files.map((file) => file.path),
      };

    case "both_ways":
      return {
        title: "The change both omits requested work and adds unrequested work",
        instruction:
          "Split this into two corrections: implement the parts of the request that are missing, and remove the work the request did not ask for.",
        evidence: [...taskChecklist(input.taskDescription).slice(0, 4), ...unrelated],
        files: input.files.map((file) => file.path),
      };

    default:
      return {
        title: "Scope does not match the request",
        instruction:
          "Check the change against the request: implement anything missing, and remove or separate anything the request did not ask for.",
        evidence: unrelated.length > 0 ? unrelated : defaultEvidence(input),
        files: input.files.map((file) => file.path),
      };
  }
}

/**
 * Files whose path and added code share no vocabulary with the request. This is
 * offered as observation ("appears unrelated"), never as a verdict, because a
 * task can legitimately require touching oddly-named files.
 */
function unrelatedEvidence(input: FeedbackInput): string[] {
  const tokens = vocabularyOf(input.taskDescription);
  if (tokens.size === 0 || input.files.length < 2) return [];
  const unrelated: string[] = [];
  for (const file of input.files) {
    if (isTestFile(file.path)) continue;
    const haystack = `${file.path}\n${file.diff ?? ""}\n${(file.content ?? "").slice(0, 4_000)}`.toLowerCase();
    let related = false;
    for (const token of tokens) {
      if (haystack.includes(token)) {
        related = true;
        break;
      }
    }
    if (!related) unrelated.push(`${file.path} shares no wording with the request and may be unrelated (${file.added} added lines)`);
  }
  return unrelated.slice(0, MAX_EVIDENCE_PER_ITEM);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "add", "make", "when", "then",
  "also", "code", "file", "files", "should", "need", "needs", "please", "using", "use", "used",
  "there", "where", "which", "would", "could", "must", "have", "has", "not", "but", "you", "your",
  "all", "any", "new", "old", "now", "let", "can", "will", "its", "it's", "how", "what", "want",
]);

function vocabularyOf(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/* ---------------- Conventions ---------------- */

function conventionFeedback(score: DimensionScore, input: FeedbackInput): Rendered {
  const baseline = input.conventions.baseline;
  const violations = input.analysis.casingViolations;
  const repoFiles = input.conventions.sampleFiles.slice(0, 5);

  if (score.reason === "naming_casing" || (!score.reason && violations.length > 0)) {
    const expected = violations[0]?.expected ?? baseline?.dominantCasing ?? null;
    const evidence = violations.slice(0, MAX_EVIDENCE_PER_ITEM).map((violation) => {
      const suggestion = expected ? toStyle(violation.name, expected) : `${violation.name} (rename to match the repo)`;
      return `${violation.path}:${violation.line} — \`${violation.name}\` is ${HUMAN_CASING[violation.actual]} but the repo uses ${expected ? HUMAN_CASING[expected] : "a different style"}; rename to \`${suggestion}\``;
    });
    const target = expected ? HUMAN_CASING[expected] : "the repository's style";
    return {
      title: "Naming does not match the repository",
      instruction: `Rename the identifiers below to ${target}. The repository's own declarations are the reference: ${input.conventions.summary}. Renaming is mechanical, so apply it across each declaration and every call site before resubmitting.`,
      evidence: evidence.length > 0 ? evidence : [`the repo uses ${target}; the new code does not`],
      files: violations.map((violation) => violation.path),
    };
  }

  if (score.reason === "formatting") {
    const style = input.analysis.newCode;
    const base = baseline;
    const differences: string[] = [];
    if (base?.indent && style.indent && base.indent !== style.indent) {
      differences.push(`indentation: the repo uses ${base.indent}, this change uses ${style.indent}`);
    }
    if (base?.quoteStyle && style.quoteStyle && base.quoteStyle !== style.quoteStyle && style.quoteStyle !== "mixed") {
      differences.push(`quotes: the repo uses ${base.quoteStyle} quotes, this change uses ${style.quoteStyle}`);
    }
    if (base?.semicolons && style.semicolons && base.semicolons !== style.semicolons && style.semicolons !== "mixed") {
      differences.push(`semicolons: the repo has them ${base.semicolons}, this change has them ${style.semicolons}`);
    }
    return {
      title: "Formatting differs from the surrounding files",
      instruction:
        "Match the formatting of the files around the change, or run the repository's formatter if it has one. Formatting differences create noise in review and in the file's history.",
      evidence: differences.length > 0 ? differences : [`repo style: ${input.conventions.summary}`],
      files: input.files.map((file) => file.path),
    };
  }

  const title =
    score.reason === "test_layout"
      ? "Tests do not follow the repository's layout"
      : score.reason === "error_handling_pattern"
        ? "Failures are handled differently from the rest of the repository"
        : score.reason === "module_or_import_layout"
          ? "Module or import layout differs from the repository"
          : score.reason === "file_or_directory_placement"
            ? "Files are placed differently from the repository's layout"
            : score.reason === "logging_or_output"
              ? "Logging does not follow the repository's pattern"
              : "The new code does not read as native to this repository";

  const identified = reasonLabel(score.dimension, score.reason) ?? "a divergence";
  return {
    title,
    instruction: `Open the repository files listed in the evidence and mirror how they handle this concern. The repository's measured style is: ${input.conventions.summary}. The judge identified this specifically: ${identified}. Copy the existing pattern rather than choosing your own.`,
    evidence: [
      ...(violations.length > 0
        ? violations.slice(0, 3).map((violation) => `${violation.path}:${violation.line} — \`${violation.name}\` is ${HUMAN_CASING[violation.actual]}, repo uses ${HUMAN_CASING[violation.expected]}`)
        : []),
      ...repoFiles.map((file) => `reference implementation in this repo: ${file}`),
      `measured repo style: ${input.conventions.summary}`,
    ],
    files: repoFiles.length > 0 ? repoFiles : input.files.map((file) => file.path),
  };
}

/* ---------------- Structure ---------------- */

function separationFeedback(score: DimensionScore, input: FeedbackInput): Rendered {
  const large = input.analysis.godFunctions;
  if (large.length === 0) {
    return {
      title: "Responsibilities are tangled together",
      instruction:
        "Split the logic along responsibility boundaries: keep I/O, validation and business rules in separate units, and share logic between files instead of copying it. The evidence lists where the change is concentrated.",
      evidence: defaultEvidence(input),
      files: input.files.map((file) => file.path),
    };
  }
  return {
    title: "A function has grown to handle too much",
    instruction:
      "Extract the distinct responsibilities out of the function(s) below. Thresholds used here: longer than " +
      `${MAX_FUNCTION_LINES} lines, or more than 15 branches. Each extracted unit should have one reason to change.`,
    evidence: large.map(
      (fn) => `${fn.path}:${fn.startLine} — \`${fn.name}\` spans ${fn.length} lines with ${fn.branches} branch points`,
    ),
    files: large.map((fn) => fn.path),
  };
}

/* ---------------- Debt ---------------- */

function debtFeedback(score: DimensionScore, input: FeedbackInput): Rendered {
  const markers = input.analysis.risks;
  const hardcoded = input.analysis.hardcoded;
  const unhandled = input.analysis.unhandledAsync;

  const hardcodedEvidence = hardcoded
    .filter((value) => value.kind !== "secret")
    .slice(0, MAX_EVIDENCE_PER_ITEM)
    .map((value) => `${value.path}:${value.line} — ${hardcodedGuidance(value.kind)}: ${value.text}`);

  if (score.reason === "hardcoded_value_that_should_be_config" || (!score.reason && hardcodedEvidence.length > 0)) {
    return {
      title: "Values that belong in configuration are hardcoded",
      instruction:
        "Move each value below into configuration: an environment variable, a config file, or a named constant declared alongside the code that owns it. Hardcoded values force a code change to alter behaviour between environments.",
      evidence: hardcodedEvidence.length > 0 ? hardcodedEvidence : defaultEvidence(input),
      files: hardcoded.map((value) => value.path),
    };
  }

  if (score.reason === "leftover_todo" || score.reason === "hacky_workaround") {
    const relevant = markers.filter(
      (risk) =>
        (score.reason === "leftover_todo" && (risk.kind === "todo" || risk.kind === "fixme")) ||
        (score.reason === "hacky_workaround" && risk.kind === "hack"),
    );
    return {
      title: score.reason === "leftover_todo" ? "Work was left marked as unfinished" : "A workaround stands in for the real fix",
      instruction:
        score.reason === "leftover_todo"
          ? "Resolve each marker below: implement what it describes, or delete it and record the work where the team tracks it. A marker left in a submitted change means the change is not finished."
          : "Address the root cause rather than working around it. If the workaround is genuinely unavoidable, explain why in a comment and record a follow-up task, then resubmit.",
      evidence: relevant.length > 0
        ? relevant.map((risk) => `${risk.path}:${risk.line} — ${risk.text}`)
        : debtEvidence(input),
      files: relevant.map((risk) => risk.path),
    };
  }

  if (score.reason === "weakened_test_or_type_check") {
    const relevant = markers.filter(
      (risk) => risk.kind === "skipped-test" || risk.kind === "only-test" || risk.kind === "ts-ignore" || risk.kind === "eslint-disable",
    );
    return {
      title: "A test or check was weakened rather than satisfied",
      instruction:
        "Restore the test or check and make the code pass it. A skipped test, a focused test, a type error suppression or a disabled rule all hide a problem instead of fixing it.",
      evidence: relevant.length > 0
        ? relevant.map((risk) => `${risk.path}:${risk.line} — ${risk.text}`)
        : debtEvidence(input),
      files: relevant.map((risk) => risk.path),
    };
  }

  if (score.reason === "debug_output_left_behind") {
    const relevant = markers.filter((risk) => risk.kind === "console-log" || risk.kind === "debugger-statement");
    return {
      title: "Debug output was left in the code",
      instruction:
        "Remove the debug output below, or replace it with the repository's logging convention if the information is genuinely useful at runtime.",
      evidence: relevant.length > 0
        ? relevant.map((risk) => `${risk.path}:${risk.line} — ${risk.text}`)
        : debtEvidence(input),
      files: relevant.map((risk) => risk.path),
    };
  }

  if (score.reason === "swallowed_error" && unhandled.length > 0) {
    return {
      title: "Errors are being swallowed",
      instruction:
        "Handle each failure below explicitly instead of letting it disappear: surface it to the caller, or log it and take a deliberate recovery action.",
      evidence: unhandled.length > 0
        ? unhandled.map((item) => `${item.path}:${item.line} in ${item.container} — ${item.excerpt}`)
        : defaultEvidence(input),
      files: unhandled.map((item) => item.path),
    };
  }

  return {
    title: "The change adds shortcuts that will need cleaning up",
    instruction:
      "Remove the shortcuts identified below. This dimension is about what the next maintainer inherits, so anything below that leaves a trap should be resolved or explicitly recorded before resubmitting.",
    evidence: debtEvidence(input),
    files: [...new Set([...markers.map((risk) => risk.path), ...hardcoded.map((value) => value.path)])],
  };
}

function hardcodedGuidance(kind: string): string {
  switch (kind) {
    case "url":
      return "endpoint URL that should be configuration";
    case "port":
      return "port that should be configuration";
    case "absolute-path":
      return "absolute path that will not work on another machine";
    case "magic-number":
      return "number that should be a named or configured constant";
    default:
      return "hardcoded value";
  }
}

function debtEvidence(input: FeedbackInput): string[] {
  const evidence: string[] = [];
  for (const risk of input.analysis.risks) {
    if (evidence.length >= MAX_EVIDENCE_PER_ITEM) break;
    evidence.push(`${risk.path}:${risk.line} — ${risk.kind}: ${risk.text}`);
  }
  for (const value of input.analysis.hardcoded) {
    if (evidence.length >= MAX_EVIDENCE_PER_ITEM) break;
    if (value.kind === "secret") continue;
    evidence.push(`${value.path}:${value.line} — ${hardcodedGuidance(value.kind)}: ${value.text}`);
  }
  return evidence.length > 0 ? evidence : defaultEvidence(input);
}

/* ---------------- Readability ---------------- */

function readabilityFeedback(score: DimensionScore, input: FeedbackInput): Rendered {
  const style = input.analysis.newCode;
  const large = input.analysis.godFunctions;
  const magic = input.analysis.hardcoded.filter((value) => value.kind === "magic-number");
  const debug = input.analysis.risks.filter(
    (risk) => risk.kind === "console-log" || risk.kind === "debugger-statement" || risk.kind === "loose-any",
  );

  const evidence: string[] = [];
  if (large.length > 0) {
    evidence.push(
      ...large.map((fn) => `${fn.path}:${fn.startLine} — \`${fn.name}\` is ${fn.length} lines long`),
    );
  }
  if (style.maxNestingDepth > 4) {
    evidence.push(`control flow reaches ${style.maxNestingDepth} levels of nesting`);
  }
  if (magic.length > 0) {
    evidence.push(...magic.slice(0, 3).map((value) => `${value.path}:${value.line} — unexplained constant ${value.text}`));
  }
  if (debug.length > 0) {
    evidence.push(...debug.slice(0, 3).map((risk) => `${risk.path}:${risk.line} — ${risk.kind}: ${risk.text}`));
  }

  const focus =
    score.reason === "overly_long_function"
      ? "Shorten the units listed below so each one can be read in a single pass."
      : score.reason === "deep_nesting"
        ? "Flatten the control flow: use early returns and guard clauses so the main path is not indented several levels deep."
        : score.reason === "unexplained_constants_or_logic"
          ? "Name or explain the constants below so their purpose is visible without reading the surrounding logic."
          : score.reason === "copy_pasted_blocks"
            ? "Extract the repeated blocks into a shared function so the variation between them is explicit."
            : score.reason === "unclear_names"
              ? "Rename the identifiers listed below so each states its intent rather than its shape."
              : "Reduce the size of the units below and make their intent visible in their names.";

  return {
    title: "The new code is harder to follow than it needs to be",
    instruction: `${focus} The change was scored ${score.score.toFixed(2)} against a ${score.threshold.toFixed(2)} bar, and the items below are what pushed it there.`,
    evidence: evidence.length > 0 ? evidence : defaultEvidence(input),
    files: [
      ...new Set([
        ...large.map((fn) => fn.path),
        ...magic.map((value) => value.path),
        ...debug.map((risk) => risk.path),
      ]),
    ],
  };
}

/* ---------------- Error handling ---------------- */

function errorHandlingFeedback(score: DimensionScore, input: FeedbackInput): Rendered {
  const unhandled = input.analysis.unhandledAsync;

  if (unhandled.length > 0) {
    const calls = unhandled.slice(0, MAX_EVIDENCE_PER_ITEM).map((item) => {
      const verb = /promise started/i.test(item.excerpt) ? "is started without await or catch" : "has no failure handling";
      return `${item.path}:${item.line} in ${item.container} — ${verb}; ${item.excerpt}`;
    });
    return {
      title: score.reason === "unhandled_rejection" ? "An async failure is not handled" : "A fallible call has no failure handling",
      instruction:
        "Wrap each call below in explicit failure handling: try/catch for awaited calls, a .catch (or an awaited try/catch) for started promises. Handle the failure rather than logging it and continuing, and make sure the caller can tell the difference between success and failure.",
      evidence: calls,
      files: unhandled.map((item) => item.path),
    };
  }

  const timeouts = sitesMatching(input.files, NETWORK_CALL);
  if (score.reason === "missing_timeout" && timeouts.length > 0) {
    return {
      title: "Network calls have no timeout",
      instruction:
        "Give each call below a timeout or an abort signal. Without one, a slow or unresponsive peer blocks the caller indefinitely.",
      evidence: timeouts,
      files: extractFiles(timeouts),
    };
  }

  const inputSites = sitesMatching(input.files, UNTRUSTED_INPUT);
  if (score.reason === "missing_input_validation" && inputSites.length > 0) {
    return {
      title: "Untrusted input is used without validation",
      instruction:
        "Validate each value below at the boundary where it enters the program, and fail with a clear error when it is invalid. Parsing input is not validating it: check the shape, type and range you actually rely on.",
      evidence: inputSites,
      files: extractFiles(inputSites),
    };
  }

  const emptyCatch = sitesMatching(input.files, EMPTY_CATCH);
  if (emptyCatch.length > 0) {
    return {
      title: "An error is caught and then ignored",
      instruction:
        "Remove the empty catch, or handle the error it swallows. An empty block turns a loud failure into a silent one, which is harder to diagnose than a crash.",
      evidence: emptyCatch,
      files: extractFiles(emptyCatch),
    };
  }

  return {
    title: "Failure paths are not handled precisely enough",
    instruction:
      "Review each fallible operation in the change and decide what should happen when it fails: which errors are recoverable, which should propagate, and what the caller can do about it. Then make that explicit in code. The evidence below shows where the change is concentrated.",
    evidence: defaultEvidence(input),
    files: input.files.map((file) => file.path),
  };
}

/**
 * Locate a pattern in the changed files and describe it with file and line. Used
 * for concerns that are cheaper to find directly than to ask a model about.
 */
function sitesMatching(files: ChangedFile[], pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (!file.content || file.status === "deleted") continue;
    const language = file.language;
    if (language !== "typescript" && language !== "javascript" && language !== "python") continue;
    const view = stripCode(file.content, language);
    const rawLines = linesOf(file.content);
    const lines = linesOf(view);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (!pattern.test(line)) continue;
      found.push(`${file.path}:${index + 1} — ${(rawLines[index] ?? "").trim().slice(0, 140)}`);
      if (found.length >= MAX_EVIDENCE_PER_ITEM) return found;
    }
  }
  return found;
}

/* ---------------- Tests ---------------- */

function testFeedback(score: DimensionScore, input: FeedbackInput): Rendered {
  const tests = input.analysis.tests;
  const codeFiles = input.files.filter(
    (file) => !isTestFile(file.path) && (file.language === "typescript" || file.language === "javascript" || file.language === "python"),
  );
  const targets = declarationNamesIn(codeFiles.slice(0, 4));

  if (score.reason === "no_tests_at_all" || (tests.testFilesChanged.length === 0 && codeFiles.length > 0)) {
    return {
      title: "The changed behaviour has no tests",
      instruction: `Add tests that exercise the changed behaviour, including at least one failure case. ${
        targets.length > 0 ? "The main units that changed are listed below." : "The files that changed are listed below."
      }${tests.framework ? ` The repository's tests use ${tests.framework}.` : ""} A test that would still pass if the change were reverted does not count.`,
      evidence: targets.length > 0 ? targets : codeFiles.map((file) => `changed: ${file.path} (${file.added} added lines)`),
      files: codeFiles.map((file) => file.path),
    };
  }

  if (score.reason === "trivial_or_assertionless_tests" || tests.assertions === 0 || tests.assertionlessTests > 0) {
    return {
      title: "The tests do not check meaningful behaviour",
      instruction:
        "Strengthen the tests so they assert on observable behaviour: call the real code and assert on its result. Asserting that a call did not throw, snapshotting without review, or asserting on a mock's own behaviour all pass regardless of whether the code is correct.",
      evidence: [
        `assertions found in changed test files: ${tests.assertions}`,
        `test cases with no assertion: ${tests.assertionlessTests}`,
        ...tests.testFilesChanged.map((file) => `test file changed: ${file}`),
        ...targets,
      ],
      files: tests.testFilesChanged,
    };
  }

  if (score.reason === "skipped_or_disabled_tests" || tests.skippedTests > 0 || tests.onlyTests > 0) {
    return {
      title: "Tests were skipped or left focused",
      instruction:
        "Remove the skip and focus markers. A skipped test is a silent gap, and a focused test stops the rest of the suite running, so both hide regressions in CI.",
      evidence: [
        `skipped tests: ${tests.skippedTests}`,
        `focused tests (.only / fit): ${tests.onlyTests}`,
        ...input.analysis.risks
          .filter((risk) => risk.kind === "skipped-test" || risk.kind === "only-test")
          .map((risk) => `${risk.path}:${risk.line} — ${risk.text}`),
      ],
      files: tests.testFilesChanged,
    };
  }

  return {
    title: "Tests cover the success path but not the edges",
    instruction: `Extend the tests to cover the failure and boundary cases of the changed behaviour: invalid input, empty or missing values, the error path, and the limits of any range.${
      targets.length > 0 ? " The changed units are listed below." : ""
    }`,
    evidence: [
      `assertions found: ${tests.assertions}`,
      ...tests.testFilesChanged.map((file) => `test file changed: ${file}`),
      ...targets,
    ],
    files: tests.testFilesChanged,
  };
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function defaultEvidence(input: FeedbackInput): string[] {
  const totals = input.analysis.totals;
  return [
    `change size: ${totals.filesChanged} file(s), +${totals.added}/-${totals.removed} lines`,
    `new code style: ${describeStyle(input.analysis.newCode)}`,
    `files changed: ${input.files.map((file) => file.path).slice(0, 10).join(", ") || "(none)"}`,
  ];
}

const UNIT_ROLES = new Set(["function", "method", "class", "type"]);

/** Named units in the changed code, so feedback can point at behaviour rather than files. */
function declarationNamesIn(files: ChangedFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (!file.content) continue;
    const language = file.language;
    if (language !== "typescript" && language !== "javascript" && language !== "python") continue;
    const stripped = stripCode(file.content, language);
    const names = extractDeclarations(stripped, language)
      .filter((declaration) => UNIT_ROLES.has(declaration.role))
      .map((declaration) => declaration.name)
      .slice(0, 6);
    if (names.length > 0) out.push(`${file.path}: ${names.map((name) => `\`${name}\``).join(", ")}`);
  }
  return out;
}

function extractFiles(lines: string[]): string[] {
  const files = new Set<string>();
  for (const line of lines) {
    const match = /([\w./-]+\.(?:[cm]?[jt]sx?|py))(?::(\d+))?/.exec(line);
    if (match?.[1]) files.add(match[1]);
  }
  return [...files];
}

function describe(score: DimensionScore): string {
  return `${score.score.toFixed(2)} against a ${score.threshold.toFixed(2)} threshold`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------ *
 * Identifier style conversion
 * ------------------------------------------------------------------ */

/**
 * Split an identifier into words. Delegates to the shared implementation in
 * `patterns.ts` so that renaming advice and tunable-name detection always agree
 * about what the words of an identifier are.
 */
export function splitWords(name: string): string[] {
  return identifierWords(name);
}

/** Convert an identifier to the target casing, preserving leading underscores. */
export function toStyle(name: string, target: CasingStyle): string {
  const leading = /^_+/.exec(name)?.[0] ?? "";
  const words = splitWords(name.slice(leading.length));
  if (words.length === 0) return name;
  const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
  switch (target) {
    case "snake_case":
      return leading + words.join("_");
    case "SCREAMING_SNAKE_CASE":
      return leading + words.join("_").toUpperCase();
    case "camelCase":
      return leading + (words[0] ?? "") + words.slice(1).map(capitalise).join("");
    case "PascalCase":
      return leading + words.map(capitalise).join("");
    case "kebab-case":
      return leading + words.join("-");
    default:
      return name;
  }
}
