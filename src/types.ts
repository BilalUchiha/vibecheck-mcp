/**
 * Shared domain types for the vibecheck review pipeline.
 */

/* ------------------------------------------------------------------ *
 * Review dimensions
 * ------------------------------------------------------------------ */

/** The dimensions Jev is asked to judge. Each is individually toggleable. */
export type GateDimension =
  | "satisfies_request"
  | "scope_appropriate"
  | "follows_conventions"
  | "separation_of_concerns"
  | "introduces_debt"
  | "readability"
  | "error_handling_present"
  | "test_coverage_adequate";

export const GATE_DIMENSIONS: GateDimension[] = [
  "satisfies_request",
  "scope_appropriate",
  "follows_conventions",
  "separation_of_concerns",
  "introduces_debt",
  "readability",
  "error_handling_present",
  "test_coverage_adequate",
];

export type Tier = "intent" | "architecture" | "quality";

/** Jev primitives. `noul` is a 0-1 yes-probability; `score` is a graded scale. */
export type QuestionKind = "noul" | "score";

/* ------------------------------------------------------------------ *
 * Changed files and context
 * ------------------------------------------------------------------ */

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** Unified diff for this file, when available. */
  diff?: string;
  /** Full file content for this file, when available. */
  content?: string;
  added: number;
  removed: number;
  language: Language | null;
  /** Where the content came from, so the verdict can state its own trust level. */
  source: "git" | "submitted";
}

export type Language = "typescript" | "javascript" | "python" | "other";

export interface ChangeTotals {
  filesChanged: number;
  added: number;
  removed: number;
  newFiles: string[];
  deletedFiles: string[];
  languages: Language[];
}

export interface TestResults {
  /** Raw output, or a structured summary, exactly as the agent supplied it. */
  raw: string;
  passed: boolean | null;
  framework: string | null;
  failures: number | null;
  summaryLine: string | null;
}

/* ------------------------------------------------------------------ *
 * Deterministic static analysis
 * ------------------------------------------------------------------ */

export type CasingStyle =
  | "snake_case"
  | "camelCase"
  | "PascalCase"
  | "SCREAMING_SNAKE_CASE"
  | "kebab-case"
  | "unknown";

export interface StyleProfile {
  /** Number of identifiers observed. */
  identifiers: number;
  casing: Record<CasingStyle, number>;
  /** The prevailing casing, or null when nothing was observed. */
  dominantCasing: CasingStyle | null;
  /** Fraction of identifiers matching `dominantCasing`, 0-1. */
  casingConsistency: number;
  quoteStyle: "single" | "double" | "mixed" | null;
  semicolons: "always" | "never" | "mixed" | null;
  indent: "tabs" | "2-space" | "4-space" | "mixed" | null;
  /** Number of lines longer than 100 characters. */
  longLines: number;
  /** Deepest brace (or indentation) nesting observed, for readability feedback. */
  maxNestingDepth: number;
}

export interface CasingViolation {
  path: string;
  line: number;
  name: string;
  actual: CasingStyle;
  expected: CasingStyle;
}

export type RiskKind =
  | "todo"
  | "fixme"
  | "hack"
  | "ts-ignore"
  | "eslint-disable"
  | "console-log"
  | "skipped-test"
  | "only-test"
  | "debugger-statement"
  | "loose-any";

export interface RiskFinding {
  kind: RiskKind;
  path: string;
  line: number;
  text: string;
}

export interface HardcodedFinding {
  kind: "url" | "secret" | "port" | "absolute-path" | "magic-number";
  path: string;
  line: number;
  text: string;
  /** For secrets we keep only a redacted preview; never log raw credentials. */
  redacted: boolean;
}

export type AsyncGapKind =
  /** An awaited call with no try/catch around it. */
  | "await_without_try"
  /** A fallible call (network, disk, parse) with no try/catch around it. */
  | "fallible_call_without_try"
  /** A promise was started and neither awaited nor given a catch, so its failure is unreachable. */
  | "floating_promise";

export interface UnhandledAsync {
  path: string;
  line: number;
  /** Enclosing function name, or a best-effort description. */
  container: string;
  excerpt: string;
  kind: AsyncGapKind;
  /**
   * True when the enclosing function contains an explicit throw/raise, which
   * means the failure may be surfaced to the caller on purpose. The distinction
   * matters: an unguarded await inside a function that rethrows is a design
   * choice, whereas a discarded promise is a defect.
   */
  propagates: boolean;
}

export interface SwallowedError {
  path: string;
  line: number;
  /** Enclosing function name, or a best-effort description. */
  container: string;
  /** The catch/except line as written, so the feedback can quote it. */
  excerpt: string;
  /** Whether the clause at least rethrows or logs, which softens the finding. */
  partiallyHandled: boolean;
}

export interface GodFunction {
  path: string;
  name: string;
  startLine: number;
  length: number;
  branches: number;
}

export interface TestSignals {
  testFilesChanged: string[];
  /** Source files changed while no test file changed at all. */
  sourceFilesWithoutTests: string[];
  assertions: number;
  /** Tests that contain no assertion call. */
  assertionlessTests: number;
  skippedTests: number;
  onlyTests: number;
  framework: string | null;
}

export interface AnalysisReport {
  newCode: StyleProfile;
  repoBaseline: StyleProfile | null;
  casingViolations: CasingViolation[];
  risks: RiskFinding[];
  hardcoded: HardcodedFinding[];
  unhandledAsync: UnhandledAsync[];
  swallowedErrors: SwallowedError[];
  godFunctions: GodFunction[];
  tests: TestSignals;
  totals: ChangeTotals;
}

/* ------------------------------------------------------------------ *
 * Jev wire types (see https://typesafe.ai/docs -> POST /v1/systemone)
 * ------------------------------------------------------------------ */

export interface NoulAnswer {
  type: "noul";
  /** Probability that the answer to the question is "yes", 0-1. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted mean of the criteria level indices. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: JevUsage;
}

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */

/**
 * The documented contract has three verdicts. Two extensions exist, for the two
 * cases where neither of the failure verdicts would be true:
 *
 * `review_unavailable` - the review could not be performed at all (no usable
 *   judge, unusable input). Reporting it as `needs_fixes` would send the agent
 *   off to fix problems that were never identified, and reporting `approved`
 *   would be a lie.
 *
 * `needs_clarification` - the task description states no checkable requirement,
 *   so "does this satisfy the request" has no determinate answer. Approving it
 *   would certify work nobody defined.
 *
 * Neither consumes a retry: in both cases the agent has no failing change to
 * work on.
 */
export type Verdict =
  | "approved"
  | "needs_fixes"
  | "max_retries_exceeded"
  | "review_unavailable"
  | "needs_clarification";

/** Verdicts that leave the retry budget untouched. */
export const NON_GATING_VERDICTS: Verdict[] = ["review_unavailable", "needs_clarification"];

/** A single question as sent to Jev. */
export interface QuestionSpec {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export interface DimensionScore {
  dimension: string;
  label: string;
  tier: Tier | "diagnostic";
  kind: QuestionKind | "choice";
  /** Normalised to 0-1, where 1 is always "good". */
  score: number;
  threshold: number;
  passed: boolean;
  weight: number;
  confidence: number | null;
  /** Human-readable level the score landed on, for `score` questions. */
  levelLabel: string | null;
  /** Machine-readable failure reason, when a diagnostic question was asked. */
  reason: string | null;
}

export interface FeedbackItem {
  dimension: string;
  /** Short imperative title, e.g. "Naming does not match the repo". */
  title: string;
  score: number;
  threshold: number;
  /** Higher first. `weight * (threshold - score)`. */
  severity: number;
  /** The concrete instruction the agent should act on. */
  instruction: string;
  /** Measured, code-grounded details that justify the instruction. */
  evidence: string[];
  /** Files the agent most likely needs to touch. */
  files: string[];
}

export interface HardGateFailure {
  gate: string;
  message: string;
  evidence: string[];
}
