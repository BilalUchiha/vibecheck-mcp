/**
 * The Jev question schema.
 *
 * Two layers of questions are asked in a *single* API call:
 *
 *  1. GATE questions - one per review dimension. These produce the scores that
 *     are compared against thresholds.
 *  2. DIAGNOSTIC questions - `choice` questions that name the *kind* of failure.
 *     Jev cannot generate prose, so it cannot tell us why a dimension failed.
 *     These questions recover that information in a typed, machine-readable
 *     form, and the feedback layer turns the chosen option into a concrete
 *     instruction. They are asked speculatively (Jev evaluates every question
 *     independently, in parallel, for the price of its own tokens) so they cost
 *     almost nothing when nothing failed.
 *
 * Two conventions are load-bearing and easy to get wrong:
 *
 *  - High must always mean good. Jev's own guidance is to phrase questions so a
 *    high probability means "yes". The debt dimension is therefore stated as
 *    "does the change *avoid* debt?" rather than "does it introduce debt?".
 *  - `score` criteria are ordered low -> high and describe *situations*, not
 *    degrees, because each level is judged independently.
 */

import type { GateDimension, QuestionKind, QuestionSpec, Tier } from "./types.js";
import { GATE_DIMENSIONS } from "./types.js";
import type { VibecheckConfig } from "./config.js";

export interface GateQuestion {
  dimension: GateDimension;
  label: string;
  tier: Tier;
  kind: QuestionKind;
  /** Sent to Jev verbatim. Backticked paths reference fields in the state. */
  instructions: string;
  criteria: Record<string, string> | string[] | null;
  /** Number of criteria levels (1 for noul). */
  levels: number;
  /** Fixed-size description of each level's meaning, for feedback rendering. */
  levelDescriptions: string[];
  /** What "passing" means, shown to the agent in the verdict. */
  passMeaning: string;
  /** Id of the diagnostic choice question that explains a failure here. */
  diagnosticId: string;
}

export interface DiagnosticQuestion {
  id: string;
  dimension: GateDimension;
  instructions: string;
  criteria: Record<string, string>;
  /** Option value -> short human phrase used in feedback. Defaults to the value. */
  labels: Record<string, string>;
}

const TIER_OF: Record<GateDimension, Tier> = {
  satisfies_request: "intent",
  scope_appropriate: "intent",
  follows_conventions: "architecture",
  separation_of_concerns: "architecture",
  introduces_debt: "architecture",
  readability: "quality",
  error_handling_present: "quality",
  test_coverage_adequate: "quality",
};

export const DIMENSION_LABELS: Record<GateDimension, string> = {
  satisfies_request: "Request satisfied",
  scope_appropriate: "Scope appropriate",
  follows_conventions: "Follows repo conventions",
  separation_of_concerns: "Separation of concerns",
  introduces_debt: "Free of new debt",
  readability: "Readability",
  error_handling_present: "Error handling",
  test_coverage_adequate: "Test adequacy",
};

/* ------------------------------------------------------------------ *
 * Tier 1 - intent match
 * ------------------------------------------------------------------ */

const READABILITY_LEVELS = [
  "A maintainer would need significant extra explanation: names are unclear or misleading, or the logic is dense enough that its intent has to be reconstructed.",
  "Followable but strained: vague or generic names (data, tmp, handle2), deep nesting, or long unlabelled blocks that hide what the code is for.",
  "Clear: intention-revealing names and a structure that can be followed in one pass, with only minor rough edges such as one long function or an unexplained constant.",
  "Immediately clear: names state intent, units and responsibilities are small and focused, and no additional explanation is needed.",
];

const ERROR_HANDLING_LEVELS = [
  "Happy path only: a failure of an I/O, network, filesystem, parsing or third-party call in the change would crash the programme or silently corrupt state.",
  "Partial: some failure handling exists but important failures are swallowed or masked - an empty catch, a caught error that is only logged and ignored, or a default value returned as if the call succeeded.",
  "Mostly handled: realistic failures are handled, but some paths are still uncovered - a call with no timeout, untrusted input used without validation, or a failure branch that cannot be acted on by the caller.",
  "Proportionate: each realistic failure mode in the change is handled explicitly, and errors are surfaced to the caller in a way it can act on. Validation is present where input is untrusted.",
];

const TEST_LEVELS = [
  "No tests were added or updated, although the change alters behaviour that tests should cover.",
  "Tests exist but do not verify behaviour meaningfully: they assert nothing, assert only that a call did not throw, snapshot without review value, or assert on mocks rather than on the changed code.",
  "The happy path of the changed behaviour is tested, but realistic failure and edge cases are not, or the tests would still pass if the change were reverted.",
  "The changed behaviour is covered including its significant failure and edge cases, and the tests would fail if the behaviour regressed.",
];

export const GATE_QUESTIONS: Record<GateDimension, GateQuestion> = {
  satisfies_request: {
    dimension: "satisfies_request",
    label: DIMENSION_LABELS.satisfies_request,
    tier: TIER_OF.satisfies_request,
    kind: "noul",
    instructions:
      "Does `changes` actually and fully accomplish what `task` asked for? Answer yes only when every explicit requirement in `task` is implemented and working. A partial implementation, a stub, placeholder or TODO standing in for requested behaviour, or different-but-adjacent work is not a yes. Ignore code quality, style and testing entirely here: judge only whether the requested outcome was delivered.",
    criteria: {
      true: "Every explicit requirement in `task` is implemented in `changes`, including the parts that were easy to overlook.",
      false: "Something explicitly asked for in `task` is missing, only partly implemented, replaced by a stub or placeholder, or answered with adjacent work that does not meet the request.",
    },
    levels: 1,
    levelDescriptions: ["not satisfied", "satisfied"],
    passMeaning: "the change delivers what the user asked for",
    diagnosticId: "diagnostic_request_gap",
  },

  scope_appropriate: {
    dimension: "scope_appropriate",
    label: DIMENSION_LABELS.scope_appropriate,
    tier: TIER_OF.scope_appropriate,
    kind: "noul",
    instructions:
      "Does the size and reach of `changes` suit `task`? Answer yes when the change addresses what was asked without under-delivering (requested pieces missing or deferred) and without ballooning beyond it (unrequested features, gratuitous rewrites, new dependencies, unrelated refactors, or reformatting of code the task did not mention). Edits that are genuinely required to complete the task, such as updating a caller of a changed signature, are still within scope.",
    criteria: {
      true: "The change covers `task` and stops there; any extra edits are required by the requested change.",
      false: "The change either leaves part of `task` undone, or makes substantial changes that `task` did not ask for.",
    },
    levels: 1,
    levelDescriptions: ["inappropriate scope", "appropriate scope"],
    passMeaning: "neither under-delivering nor scope-creeping",
    diagnosticId: "diagnostic_scope_direction",
  },

  follows_conventions: {
    dimension: "follows_conventions",
    label: DIMENSION_LABELS.follows_conventions,
    tier: TIER_OF.follows_conventions,
    kind: "noul",
    instructions:
      "Does `changes` follow the conventions already established in this repository, as shown by `repo_style`, including the real code excerpts in `repo_style.reference_files` and any `repo_style.style_guide`? Compare naming and casing, file and directory placement, module and import layout, error-handling and logging patterns, and test layout. Answer yes when an existing maintainer would read the new code as belonging to this repository. Judge against `repo_style`, not against general best practice, and not against the style you would personally choose. If `repo_style` says nothing about a given convention, ignore it.",
    criteria: {
      true: "Naming, placement, imports and patterns in `changes` are consistent with `repo_style`.",
      false: "`changes` visibly diverges from a convention that `repo_style` shows is established, such as using a different naming style to the surrounding code.",
    },
    levels: 1,
    levelDescriptions: ["diverges from the repo", "consistent with the repo"],
    passMeaning: "the new code looks native to this repository",
    diagnosticId: "diagnostic_convention_gap",
  },

  separation_of_concerns: {
    dimension: "separation_of_concerns",
    label: DIMENSION_LABELS.separation_of_concerns,
    tier: TIER_OF.separation_of_concerns,
    kind: "noul",
    instructions:
      "Are responsibilities within `changes` separated sensibly? Answer no when one function or file does several unrelated jobs (parsing, validation, I/O and formatting all in one place), when business rules are embedded in a UI, transport or persistence layer, when whole blocks are copy-pasted between changed files instead of shared, or when `analysis.large_functions` shows a function that has grown to handle multiple responsibilities. Judge only the structure of the code in `changes`, not its formatting or naming.",
    criteria: {
      true: "Each unit in `changes` has one clear responsibility and the boundaries between layers are respected.",
      false: "Unrelated responsibilities are tangled together, or substantial logic is duplicated across the changed files.",
    },
    levels: 1,
    levelDescriptions: ["responsibilities tangled", "responsibilities separated"],
    passMeaning: "logic is split along sensible boundaries",
    diagnosticId: "diagnostic_separation_gap",
  },

  introduces_debt: {
    dimension: "introduces_debt",
    label: DIMENSION_LABELS.introduces_debt,
    tier: TIER_OF.introduces_debt,
    kind: "noul",
    instructions:
      "Does `changes` avoid adding shortcuts that will cause problems later? Answer yes when the change leaves the codebase in a neutral or healthier state, and no when it adds: a workaround that papers over a root-cause bug, leftover TODO/FIXME/HACK markers, hardcoded values (URLs, credentials, ports, paths, limits) that belong in configuration, dead or commented-out code, a disabled or weakened test, linter or type check, a swallowed error, or logic duplicated instead of extracted. `analysis.risk_markers`, `analysis.hardcoded_values` and `analysis.unhandled_async` list concrete instances from the added lines; treat them as evidence to weigh, not as automatic disqualifiers. Removing pre-existing debt is a yes.",
    criteria: {
      true: "The change is free of new shortcuts, or it removes some that already existed.",
      false: "The change introduces at least one shortcut that a future maintainer would have to clean up, such as a hardcoded value or a workaround around a bug that was not fixed.",
    },
    levels: 1,
    levelDescriptions: ["adds debt", "no new debt"],
    passMeaning: "no shortcuts that will need cleaning up later",
    diagnosticId: "diagnostic_debt_kind",
  },

  /* ---------------- Tier 3 - code quality ---------------- */

  readability: {
    dimension: "readability",
    label: DIMENSION_LABELS.readability,
    tier: TIER_OF.readability,
    kind: "score",
    instructions:
      "How easy would it be for a maintainer who did not write this change to understand `changes` without extra explanation? Consider naming, nesting depth, unit length and whether intent is expressed in the code rather than only in comments. Choose the level that describes the situation. Judge the readability of the new and modified code only.",
    criteria: READABILITY_LEVELS,
    levels: READABILITY_LEVELS.length,
    levelDescriptions: READABILITY_LEVELS,
    passMeaning: "a maintainer can follow the new code in one pass",
    diagnosticId: "diagnostic_readability_gap",
  },

  error_handling_present: {
    dimension: "error_handling_present",
    label: DIMENSION_LABELS.error_handling_present,
    tier: TIER_OF.error_handling_present,
    kind: "score",
    instructions:
      "How well does `changes` handle realistic failure? Examine every fallible operation in the change - I/O, network requests, filesystem access, parsing, database and third-party calls - and ask whether its failure would be handled or would crash or silently corrupt state. Also consider whether untrusted input is validated. `analysis.unhandled_async` lists awaits that appear to have no failure handling around them. Choose the level describing the situation. If the change performs no fallible operation at all, choose the highest level.",
    criteria: ERROR_HANDLING_LEVELS,
    levels: ERROR_HANDLING_LEVELS.length,
    levelDescriptions: ERROR_HANDLING_LEVELS,
    passMeaning: "realistic failures are handled and surfaced",
    diagnosticId: "diagnostic_error_handling_gap",
  },

  test_coverage_adequate: {
    dimension: "test_coverage_adequate",
    label: DIMENSION_LABELS.test_coverage_adequate,
    tier: TIER_OF.test_coverage_adequate,
    kind: "score",
    instructions:
      "How adequate is the automated testing of the behaviour changed in `changes`? Consider the test files among `changes` and the output in `tests`. Count a test as meaningful only when it asserts an observable behaviour of the changed code, and would fail if that behaviour regressed. `analysis.tests` reports assertion counts, test files changed, and any assertion-less or skipped tests. Choose the level describing the situation. If the change is documentation, configuration, formatting or dependency-only with no testable behaviour, choose the highest level.",
    criteria: TEST_LEVELS,
    levels: TEST_LEVELS.length,
    levelDescriptions: TEST_LEVELS,
    passMeaning: "the changed behaviour is actually verified",
    diagnosticId: "diagnostic_test_gap",
  },
};

/* ------------------------------------------------------------------ *
 * Diagnostic questions (choice)
 * ------------------------------------------------------------------ */

export const DIAGNOSTIC_QUESTIONS: DiagnosticQuestion[] = [
  {
    id: "diagnostic_request_gap",
    dimension: "satisfies_request",
    instructions:
      "If `changes` does NOT fully accomplish `task`, what is the nature of the most significant gap? Choose `none` when every explicit requirement in `task` is implemented.",
    criteria: {
      none: "Nothing requested in `task` is missing.",
      partial_implementation: "Part of a requirement is implemented, but the rest of it is not.",
      adjacent_work: "The change is related to `task` but does not deliver the behaviour that was asked for.",
      missing_requirement: "A requirement stated in `task` is absent entirely.",
      wrong_interface: "The behaviour exists but is exposed differently from how `task` described it, such as a different name, argument or return shape.",
      stub_or_placeholder: "In place of the requested behaviour there is a stub, placeholder, mock, or a TODO describing the work that remains.",
      extra_unrequested_work: "The requested behaviour is present, but it is delivered alongside substantial unrequested behaviour.",
    },
    labels: {
      none: "nothing requested is missing",
      partial_implementation: "a requirement is only partly implemented",
      adjacent_work: "the change is adjacent to the request rather than answering it",
      missing_requirement: "a stated requirement is missing entirely",
      wrong_interface: "the behaviour is exposed differently from what was asked",
      stub_or_placeholder: "the behaviour is a stub, placeholder or TODO",
      extra_unrequested_work: "unrequested behaviour was added alongside the request",
    },
  },
  {
    id: "diagnostic_scope_direction",
    dimension: "scope_appropriate",
    instructions:
      "How does the size of `changes` relate to what `task` asked for? Choose `about_right` when the change covers the request without adding or omitting more than is needed.",
    criteria: {
      about_right: "The change matches the size and reach of the request.",
      under_delivered: "Part of the request is missing or deferred.",
      over_delivered: "The change does more than the request asked for.",
      both_ways: "The change both omits part of the request and adds unrequested work.",
    },
    labels: {
      about_right: "the scope matches the request",
      under_delivered: "it under-delivers on the request",
      over_delivered: "it does more than the request asked for",
      both_ways: "it both omits requested work and adds unrequested work",
    },
  },
  {
    id: "diagnostic_convention_gap",
    dimension: "follows_conventions",
    instructions:
      "Which convention established in `repo_style` does `changes` most visibly diverge from? Choose `none` when the change is consistent with `repo_style`.",
    criteria: {
      none: "The change is consistent with the repository's conventions.",
      naming_casing: "Names use a different casing or naming style from the surrounding code.",
      file_or_directory_placement: "Files are placed in a directory the repository does not use for that kind of code.",
      module_or_import_layout: "Imports or module structure differ from the repository's pattern.",
      error_handling_pattern: "Failures are handled in a different way from the rest of the repository.",
      logging_or_output: "Logging or user-facing output does not follow the repository's pattern.",
      test_layout: "Tests are placed or named differently from the repository's other tests.",
      formatting: "Indentation, quotes, semicolons or line length differ from the surrounding files.",
    },
    labels: {
      none: "it is consistent with the repo",
      naming_casing: "naming and casing differ from the surrounding code",
      file_or_directory_placement: "files are placed differently from the repo's layout",
      module_or_import_layout: "imports or module structure differ from the repo's pattern",
      error_handling_pattern: "failures are handled differently from the rest of the repo",
      logging_or_output: "logging or output does not follow the repo's pattern",
      test_layout: "tests are named or placed differently from the repo's tests",
      formatting: "formatting differs from the surrounding files",
    },
  },
  {
    id: "diagnostic_separation_gap",
    dimension: "separation_of_concerns",
    instructions:
      "What most hampers separation of concerns in `changes`? Choose `none` when responsibilities are separated well.",
    criteria: {
      none: "Responsibilities are separated well.",
      god_function: "One function or method has grown to handle many unrelated jobs.",
      mixed_layers: "Code that belongs to different layers sits in the same place.",
      business_logic_in_ui_or_transport: "Business rules are embedded in a UI, transport or persistence layer.",
      duplicated_logic_across_files: "The same logic is repeated across changed files instead of being shared.",
      hidden_side_effects: "A function does more than its name and signature suggest.",
      unclear_module_boundary: "A module reaches into another module's internals.",
    },
    labels: {
      none: "responsibilities are separated well",
      god_function: "one function handles too many unrelated jobs",
      mixed_layers: "code from different layers is combined in one place",
      business_logic_in_ui_or_transport: "business rules are embedded in a UI or transport layer",
      duplicated_logic_across_files: "the same logic is duplicated across files",
      hidden_side_effects: "a function does more than its name suggests",
      unclear_module_boundary: "a module reaches into another module's internals",
    },
  },
  {
    id: "diagnostic_debt_kind",
    dimension: "introduces_debt",
    instructions:
      "Which kind of shortcut in `changes` is most serious? Choose `none` when the change contains no shortcut that a future maintainer would have to clean up.",
    criteria: {
      none: "The change is free of new shortcuts.",
      hacky_workaround: "Logic works around a bug or limitation instead of addressing it.",
      leftover_todo: "A TODO, FIXME or HACK marker is left behind.",
      hardcoded_value_that_should_be_config: "A value that should be configurable is written directly into the code.",
      dead_or_commented_code: "Code is unreachable or left commented out.",
      weakened_test_or_type_check: "A test, linter rule or type check is skipped, disabled or loosened.",
      swallowed_error: "An error is caught and ignored rather than handled.",
      duplicated_logic: "Logic is copied rather than shared.",
      debug_output_left_behind: "Debug output such as a print or console log is left in place as though it were production code.",
    },
    labels: {
      none: "no shortcuts worth cleaning up",
      hacky_workaround: "a workaround stands in for a real fix",
      leftover_todo: "TODO/FIXME/HACK markers are left in the code",
      hardcoded_value_that_should_be_config: "a value is hardcoded that should be configurable",
      dead_or_commented_code: "dead or commented-out code is left behind",
      weakened_test_or_type_check: "a test, linter rule or type check was weakened or disabled",
      swallowed_error: "an error is caught and ignored",
      duplicated_logic: "logic was duplicated rather than shared",
      debug_output_left_behind: "debug output was left in the code",
    },
  },
  {
    id: "diagnostic_readability_gap",
    dimension: "readability",
    instructions:
      "What most hampers the readability of `changes`? Choose `none` when the new code reads clearly without extra explanation.",
    criteria: {
      none: "The new code reads clearly.",
      unclear_names: "Names are vague, abbreviated or misleading.",
      deep_nesting: "Control flow is nested deeply enough to be hard to follow.",
      overly_long_function: "A function is long enough that its purpose is hard to hold in mind.",
      unexplained_constants_or_logic: "Important constants or non-obvious logic have no explanation.",
      copy_pasted_blocks: "Blocks of code are repeated with small variations.",
      misleading_comments: "Comments are stale, wrong, or restate the code without adding information.",
    },
    labels: {
      none: "it reads clearly",
      unclear_names: "names are vague or misleading",
      deep_nesting: "control flow is nested too deeply",
      overly_long_function: "a function is too long to hold in mind",
      unexplained_constants_or_logic: "important logic or constants are unexplained",
      copy_pasted_blocks: "blocks are copy-pasted with small variations",
      misleading_comments: "comments are stale, wrong, or merely restate the code",
    },
  },
  {
    id: "diagnostic_error_handling_gap",
    dimension: "error_handling_present",
    instructions:
      "Which failure-handling weakness in `changes` is most serious? Choose `not_applicable` when the change performs no fallible operation at all, and `none` when every realistic failure is handled.",
    criteria: {
      not_applicable: "The change performs no fallible operation.",
      none: "All realistic failures are handled.",
      missing_try_catch: "A fallible call can throw or fail with no handling around it.",
      unhandled_rejection: "A promise or async call is not awaited and its failure is not handled.",
      ignored_error_return: "An error return value or error result is not checked.",
      missing_input_validation: "Input from a user, file, network or other untrusted source is used without validation.",
      missing_timeout: "A network or long-running call has no timeout or cancellation.",
      missing_failure_branch: "A failure case is handled so vaguely that the caller cannot act on it.",
    },
    labels: {
      not_applicable: "no fallible operations in the change",
      none: "all realistic failures are handled",
      missing_try_catch: "a fallible call has no failure handling",
      unhandled_rejection: "an async failure is not handled",
      ignored_error_return: "an error return value is not checked",
      missing_input_validation: "untrusted input is used without validation",
      missing_timeout: "a network call has no timeout",
      missing_failure_branch: "a failure case is handled too vaguely to act on",
    },
  },
  {
    id: "diagnostic_test_gap",
    dimension: "test_coverage_adequate",
    instructions:
      "What is the weakest part of the testing of `changes`? Choose `not_applicable` when the change has no testable behaviour, and `none` when the testing is adequate.",
    criteria: {
      not_applicable: "The change has no testable behaviour.",
      none: "Testing is adequate for the changed behaviour.",
      no_tests_at_all: "No tests cover the changed behaviour.",
      trivial_or_assertionless_tests: "Tests exist but assert nothing meaningful about the changed code.",
      happy_path_only: "Only the success path is tested.",
      missing_edge_cases: "Failure and boundary cases of the changed behaviour are untested.",
      tests_do_not_exercise_changed_code: "Tests run without exercising the code that changed.",
      skipped_or_disabled_tests: "Tests are skipped, disabled or left focused on one case.",
    },
    labels: {
      not_applicable: "the change has no testable behaviour",
      none: "testing is adequate",
      no_tests_at_all: "nothing covers the changed behaviour",
      trivial_or_assertionless_tests: "the tests assert nothing meaningful",
      happy_path_only: "only the success path is tested",
      missing_edge_cases: "failure and boundary cases are untested",
      tests_do_not_exercise_changed_code: "the tests do not exercise the changed code",
      skipped_or_disabled_tests: "tests are skipped or left focused",
    },
  },
];

export const DIAGNOSTIC_BY_ID: Record<string, DiagnosticQuestion> = Object.fromEntries(
  DIAGNOSTIC_QUESTIONS.map((q) => [q.id, q]),
);

/** Every gate dimension, in reporting order. */
export const GATE_ORDER: GateDimension[] = GATE_DIMENSIONS;

/**
 * Assemble the full question set for one review.
 *
 * Gate questions for the enabled dimensions are always included. Diagnostic
 * questions are added for every enabled dimension's failure mode, not only for
 * the ones we expect to fail: Jev evaluates all questions in one parallel pass,
 * so a speculative question costs only its own tokens, and having the answer
 * ready is what allows a specific fix instruction rather than a generic one.
 */
export function buildJudgeQuestions(config: VibecheckConfig): Record<string, QuestionSpec> {
  const questions: Record<string, QuestionSpec> = {};

  for (const dimension of GATE_DIMENSIONS) {
    if (!config.questions[dimension]?.enabled) continue;
    const gate = GATE_QUESTIONS[dimension];
    questions[dimension] = {
      type: gate.kind,
      instructions: gate.instructions,
      ...(gate.kind === "score"
        ? { criteria: gate.criteria as unknown as string[] }
        : { criteria: gate.criteria as Record<string, string> }),
    };
  }

  if (config.judge.diagnostics) {
    for (const diagnostic of DIAGNOSTIC_QUESTIONS) {
      if (!config.questions[diagnostic.dimension]?.enabled) continue;
      questions[diagnostic.id] = {
        type: "choice",
        instructions: diagnostic.instructions,
        criteria: diagnostic.criteria,
      };
    }
  }

  return questions;
}

/** Normalise a raw Jev score onto 0-1 where 1 is good. */
export function normaliseScore(question: GateQuestion, raw: number): number {
  if (question.levels <= 1) return clamp01(raw);
  return clamp01(raw / (question.levels - 1));
}

/** The inverse, for explaining a threshold in level terms. */
export function thresholdInLevels(question: GateQuestion, threshold: number): number {
  if (question.levels <= 1) return threshold;
  return threshold * (question.levels - 1);
}

/** Human label for the level a normalised score corresponds to. */
export function levelLabelFor(question: GateQuestion, normalised: number): string | null {
  if (question.levels <= 1) return null;
  const index = Math.round(clamp01(normalised) * (question.levels - 1));
  return question.levelDescriptions[index] ?? null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
