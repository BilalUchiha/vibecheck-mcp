/**
 * Deterministic static analysis of a change set.
 *
 * This module exists because Jev cannot generate prose: it returns scores, not
 * explanations. For the feedback layer to say "this file uses camelCase but the
 * repo uses snake_case", *we* have to know that as a fact. So the analyzer
 * measures what is measurable, and the feedback layer only ever states what was
 * measured.
 *
 * Every detector is a heuristic, and each one is written to under-claim rather
 * than over-claim: where a signal is ambiguous the analyzer stays silent instead
 * of inventing a violation. A false positive is an accusation about code that is
 * fine, which costs the agent real work; silence costs nothing.
 *
 * Escape-sensitive patterns live in `patterns.ts` and are covered by
 * `test/patterns.test.ts`, because a single wrong backslash turns a detector
 * into a silent no-op rather than an error.
 */

import {
  AWAIT_CALL,
  BENIGN_URL,
  CATCH_HANDLER,
  EMPTY_CATCH_LINE,
  PLACEHOLDER_VALUE,
  PY_EXCEPT_CLAUSE,
  PY_EXCEPT_HANDLES,
  PY_PASS,
  RETHROW,
  SECRET_PATTERNS,
  TRY_BLOCK_JS,
  TRY_BLOCK_PY,
  FALLIBLE_JS_CALL,
  FALLIBLE_PY_CALL,
  isNamedConstantLine,
  mentionsTunableName,
  tunableNumbersIn,
} from "./patterns.js";
import {
  addedLineNumbers,
  classifyCasing,
  detectLanguage,
  detectTestFramework,
  extractDeclarations,
  HUMAN_CASING,
  isTestFile,
  linesOf,
  stripCode,
} from "./lang.js";
import type {
  AnalysisReport,
  AsyncGapKind,
  CasingStyle,
  CasingViolation,
  ChangedFile,
  ChangeTotals,
  GodFunction,
  HardcodedFinding,
  Language,
  RiskFinding,
  RiskKind,
  StyleProfile,
  SwallowedError,
  TestSignals,
  UnhandledAsync,
} from "../types.js";

/** A function longer than this, or with more branches, is reported. */
export const MAX_FUNCTION_LINES = 60;
export const MAX_FUNCTION_BRANCHES = 15;
/** A repository convention is only asserted when the sample is this consistent. */
export const BASELINE_CONSISTENCY_FLOOR = 0.6;
/** Below this many discriminating declarations a profile is too small to trust. */
export const MIN_BASELINE_IDENTIFIERS = 8;

const EMPTY_CASING: Record<CasingStyle, number> = {
  snake_case: 0,
  camelCase: 0,
  PascalCase: 0,
  SCREAMING_SNAKE_CASE: 0,
  "kebab-case": 0,
  unknown: 0,
};

/* ------------------------------------------------------------------ *
 * Style profiling
 * ------------------------------------------------------------------ */

export function emptyProfile(): StyleProfile {
  return {
    identifiers: 0,
    casing: { ...EMPTY_CASING },
    dominantCasing: null,
    casingConsistency: 0,
    quoteStyle: null,
    semicolons: null,
    indent: null,
    longLines: 0,
    maxNestingDepth: 0,
  };
}

/** Deepest nesting observed: brace depth for JS/TS, indentation level for Python. */
export function maxNestingDepthOf(code: string, language: Language): number {
  const lines = linesOf(code);

  if (language === "python") {
    let unit = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent > 0 && (unit === 0 || indent < unit)) unit = indent;
    }
    if (unit === 0) return 0;
    let deepest = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      deepest = Math.max(deepest, Math.floor((line.length - line.trimStart().length) / unit));
    }
    return deepest;
  }

  let depth = 0;
  let deepest = 0;
  for (const line of lines) {
    for (const char of line) {
      if (char === "{") {
        depth++;
        if (depth > deepest) deepest = depth;
      } else if (char === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return deepest;
}

export function profileSource(source: string, language: Language): StyleProfile {
  const code = stripCode(source, language);
  const profile = emptyProfile();
  if (!code.trim()) return profile;

  for (const declaration of extractDeclarations(code, language)) {
    profile.casing[classifyCasing(declaration.name)] += 1;
  }
  // Only discriminating names count: casing-neutral identifiers such as `data`
  // are valid in every style and would otherwise dilute the consistency measure.
  profile.identifiers =
    profile.casing.camelCase +
    profile.casing.snake_case +
    profile.casing.PascalCase +
    profile.casing.SCREAMING_SNAKE_CASE +
    profile.casing["kebab-case"];

  const dominant = dominantCasingOf(profile.casing);
  profile.dominantCasing = dominant.style;
  profile.casingConsistency = dominant.share;

  const lines = linesOf(code).filter((line) => line.trim().length > 0);
  profile.quoteStyle = detectQuoteStyle(code);
  // Semicolons are not a Python convention; reporting them would put a
  // meaningless line about the repository into the state the model reads.
  profile.semicolons = language === "python" ? null : detectSemicolons(lines);
  profile.indent = detectIndent(lines);
  profile.longLines = lines.filter((line) => line.length > 100).length;
  profile.maxNestingDepth = maxNestingDepthOf(code, language);

  return profile;
}

function dominantCasingOf(casing: Record<CasingStyle, number>): { style: CasingStyle | null; share: number } {
  const candidates: CasingStyle[] = ["camelCase", "snake_case", "PascalCase", "SCREAMING_SNAKE_CASE", "kebab-case"];
  let total = 0;
  let best: CasingStyle | null = null;
  let bestCount = 0;
  for (const style of candidates) {
    const count = casing[style];
    total += count;
    if (count > bestCount) {
      bestCount = count;
      best = style;
    }
  }
  if (!best || total === 0) return { style: null, share: 0 };
  return { style: best, share: bestCount / total };
}

function detectQuoteStyle(code: string): StyleProfile["quoteStyle"] {
  let single = 0;
  let double = 0;
  for (const char of code) {
    if (char === "'") single++;
    else if (char === '"') double++;
  }
  const total = single + double;
  if (total < 6) return null;
  const ratio = single / total;
  if (ratio >= 0.85) return "single";
  if (ratio <= 0.15) return "double";
  return "mixed";
}

const OPERATOR_ENDINGS = /[+\-*/%=&|!<>?:,([{]$/;

function detectSemicolons(lines: string[]): StyleProfile["semicolons"] {
  let withSemi = 0;
  let withoutSemi = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
    if (/^(?:import|export)\b/.test(trimmed) && !trimmed.endsWith(";")) continue;
    if (OPERATOR_ENDINGS.test(trimmed)) continue;
    // A closing brace is ambiguous (block end vs object literal) so it counts as
    // evidence for neither style.
    if (trimmed.endsWith("}")) continue;
    if (trimmed.endsWith(";")) withSemi++;
    else if (/[)\]"'`\w]$/.test(trimmed)) withoutSemi++;
  }
  const total = withSemi + withoutSemi;
  if (total < 8) return null;
  const ratio = withSemi / total;
  if (ratio >= 0.9) return "always";
  if (ratio <= 0.1) return "never";
  return "mixed";
}

function detectIndent(lines: string[]): StyleProfile["indent"] {
  const units = new Set<number>();
  for (const line of lines) {
    const match = /^([ \t]+)\S/.exec(line);
    if (!match || !match[1]) continue;
    if (match[1].includes("\t")) units.add(-1);
    else units.add(match[1].length);
  }
  if (units.size === 0) return null;
  if (units.has(-1)) return units.size === 1 ? "tabs" : "mixed";
  const numeric = [...units].filter((value) => value > 0).sort((a, b) => a - b);
  const unit = numeric[0];
  if (unit === undefined) return null;
  if (unit === 2) return "2-space";
  if (unit === 4) return "4-space";
  return "mixed";
}

export function mergeProfiles(profiles: StyleProfile[]): StyleProfile {
  const merged = emptyProfile();
  if (profiles.length === 0) return merged;

  for (const profile of profiles) {
    merged.identifiers += profile.identifiers;
    for (const key of Object.keys(EMPTY_CASING) as CasingStyle[]) {
      merged.casing[key] += profile.casing[key];
    }
    merged.longLines += profile.longLines;
    merged.maxNestingDepth = Math.max(merged.maxNestingDepth, profile.maxNestingDepth);
  }

  const dominant = dominantCasingOf(merged.casing);
  merged.dominantCasing = dominant.style;
  merged.casingConsistency = dominant.share;
  merged.quoteStyle = majority(profiles.map((profile) => profile.quoteStyle));
  merged.semicolons = majority(profiles.map((profile) => profile.semicolons));
  merged.indent = majority(profiles.map((profile) => profile.indent));
  return merged;
}

function majority<T extends string>(values: (T | null)[]): T | null {
  const counts = new Map<T, number>();
  let considered = 0;
  for (const value of values) {
    if (value === null) continue;
    considered++;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  if (considered === 0) return null;
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = value;
    }
  }
  // A split sample is not a convention.
  if (best && bestCount / considered <= 0.5 && counts.size > 1) return null;
  return best;
}

/* ------------------------------------------------------------------ *
 * Casing violations against a baseline
 * ------------------------------------------------------------------ */

/** Classes and type aliases are PascalCase in every stack we support. */
const PASCAL_ROLES = new Set(["class", "type"]);

export function expectedCasingFor(
  role: string,
  baseline: StyleProfile,
  language: Language,
): CasingStyle | null {
  if (PASCAL_ROLES.has(role)) return "PascalCase";
  const dominant = baseline.dominantCasing;
  if (!dominant) return null;
  if (dominant === "PascalCase") return null;
  // SCREAMING_SNAKE_CASE is a module-level constant convention in both stacks and
  // kebab-case belongs to file names, so neither discriminates identifiers.
  if (dominant === "SCREAMING_SNAKE_CASE" || dominant === "kebab-case") return null;
  if (language === "other") return null;
  return dominant;
}

export function findCasingViolations(
  files: { path: string; content: string; language: Language; consideredLines?: Set<number> | null }[],
  baseline: StyleProfile,
): CasingViolation[] {
  if (!baseline.dominantCasing || baseline.casingConsistency < BASELINE_CONSISTENCY_FLOOR) return [];
  if (baseline.identifiers < MIN_BASELINE_IDENTIFIERS) return [];

  const violations: CasingViolation[] = [];
  for (const file of files) {
    const code = stripCode(file.content, file.language);
    for (const declaration of extractDeclarations(code, file.language)) {
      if (declaration.role === "parameter") continue;
      const actual = classifyCasing(declaration.name);
      if (actual === "unknown" || actual === "SCREAMING_SNAKE_CASE" || actual === "kebab-case") continue;
      const expected = expectedCasingFor(declaration.role, baseline, file.language);
      if (!expected || actual === expected) continue;
      if (file.consideredLines && !file.consideredLines.has(declaration.line)) continue;
      violations.push({
        path: file.path,
        line: declaration.line,
        name: declaration.name,
        actual,
        expected,
      });
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ *
 * Risk markers
 * ------------------------------------------------------------------ */

interface RiskRule {
  kind: RiskKind;
  regex: RegExp;
  /** Which view of the file the marker is visible in. */
  view: "comments" | "code";
  languages: Language[];
}

const ALL_CODE: Language[] = ["typescript", "javascript", "python"];
const JS_ONLY: Language[] = ["typescript", "javascript"];

const RISK_RULES: RiskRule[] = [
  { kind: "todo", regex: /\bTODO\b/i, view: "comments", languages: ALL_CODE },
  { kind: "fixme", regex: /\bFIXME\b/i, view: "comments", languages: ALL_CODE },
  { kind: "hack", regex: /\b(?:HACK|XXX|WORKAROUND)\b/, view: "comments", languages: ALL_CODE },
  {
    kind: "ts-ignore",
    regex: /@ts-(?:ignore|nocheck|expect-error)|@noqa|\bnoqa\b/,
    view: "comments",
    languages: ALL_CODE,
  },
  {
    kind: "eslint-disable",
    regex: /eslint-disable|# type:\s*ignore|# pylint:\s*disable/,
    view: "comments",
    languages: ALL_CODE,
  },
  { kind: "console-log", regex: /\bconsole\.(?:log|debug|dir)\s*\(/, view: "code", languages: JS_ONLY },
  { kind: "console-log", regex: /^\s*print\s*\(/, view: "code", languages: ["python"] },
  {
    kind: "debugger-statement",
    regex: /\bdebugger\b|\bbreakpoint\s*\(/,
    view: "code",
    languages: ALL_CODE,
  },
  { kind: "only-test", regex: /\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/, view: "code", languages: JS_ONLY },
  {
    kind: "skipped-test",
    regex: /\.(?:skip|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/,
    view: "code",
    languages: JS_ONLY,
  },
  {
    kind: "skipped-test",
    regex: /@pytest\.mark\.(?:skip|xfail)|unittest\.skip|@unittest\.skip/,
    view: "code",
    languages: ["python"],
  },
  {
    kind: "loose-any",
    regex: /:\s*any\b|<any>|\bas\s+any\b|\b: any\[\]/,
    view: "code",
    languages: JS_ONLY,
  },
];

export function findRisks(
  path: string,
  content: string,
  language: Language,
  consideredLines: Set<number> | null,
): RiskFinding[] {
  if (language === "other") return [];
  const codeLines = linesOf(stripCode(content, language));
  const commentLines = linesOf(stripCode(content, language, { blankStrings: true, blankComments: false }));
  const rawLines = linesOf(content);
  const views = { code: codeLines, comments: commentLines };
  const findings: RiskFinding[] = [];
  const seen = new Set<string>();

  for (const rule of RISK_RULES) {
    if (!rule.languages.includes(language)) continue;
    const lines = views[rule.view];
    for (let index = 0; index < lines.length; index++) {
      const lineNumber = index + 1;
      if (consideredLines && !consideredLines.has(lineNumber)) continue;
      if (!rule.regex.test(lines[index] ?? "")) continue;
      const key = `${rule.kind}:${lineNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        kind: rule.kind,
        path,
        line: lineNumber,
        text: truncate((rawLines[index] ?? "").trim(), 160),
      });
    }
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * Hardcoded values
 * ------------------------------------------------------------------ */

export function findHardcoded(
  path: string,
  content: string,
  language: Language,
  consideredLines: Set<number> | null,
): HardcodedFinding[] {
  if (language === "other") return [];
  // Strings must stay visible: that is where these values live. Comments are
  // removed so a URL in a comment is not mistaken for a hardcoded value.
  const viewLines = linesOf(stripCode(content, language, { blankStrings: false, blankComments: true }));
  const rawLines = linesOf(content);
  const findings: HardcodedFinding[] = [];
  // A literal expected value in a test is not configuration, so tests are exempt
  // from the magic-number rule entirely.
  const isTest = isTestFile(path);

  for (let index = 0; index < viewLines.length; index++) {
    const line = viewLines[index] ?? "";
    const lineNumber = index + 1;
    if (consideredLines && !consideredLines.has(lineNumber)) continue;
    const rawLine = rawLines[index] ?? "";
    if (!line.trim()) continue;

    const push = (kind: HardcodedFinding["kind"], text: string, redacted = false): void => {
      findings.push({ kind, path, line: lineNumber, text: truncate(text, 160), redacted });
    };

    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const captured = match[1] ?? match[0];
      if (PLACEHOLDER_VALUE.test(captured) || PLACEHOLDER_VALUE.test(line)) continue;
      push("secret", redact(rawLine.trim()), true);
      break;
    }

    for (const url of line.match(/https?:\/\/[^\s"'`)\]}>]+/g) ?? []) {
      if (BENIGN_URL.test(url)) continue;
      push("url", url);
      break;
    }

    const port = /\bport\s*[:=]\s*['"]?(\d{2,5})\b/i.exec(line);
    if (port) push("port", port[0]);

    const absolute = /["'`](\/(?:Users|home|var|tmp|opt|etc|srv)\/[^"'`\s]+|(?:[A-Za-z]:\\)[^"'`\s]+)["'`]/.exec(line);
    if (absolute?.[1]) push("absolute-path", absolute[1]);

    // Naming a number is the fix for a magic number, so an assignment is exempt.
    if (!isTest && !isNamedConstantLine(line)) {
      // The tunable-looking name often sits on an earlier line, such as the
      // function declaration above `return attempt * 30000;`.
      const context = [viewLines[index - 3] ?? "", viewLines[index - 2] ?? "", viewLines[index - 1] ?? "", line].join("\n");
      if (mentionsTunableName(context)) {
        const numbers = tunableNumbersIn(line);
        if (numbers.length > 0) push("magic-number", numbers[0] ?? "");
      }
    }
  }

  return findings;
}

function redact(line: string): string {
  // Keep enough context to locate the line, never the credential itself.
  const match = /["'`]([^"'`\n]{8,})["'`]/.exec(line);
  if (match?.[1]) {
    const value = match[1];
    return line.replace(value, `${value.slice(0, 4)}…[redacted ${value.length} chars]`);
  }
  return truncate(
    line.replace(/[A-Za-z0-9_-]{16,}/g, (found) => `${found.slice(0, 4)}…[redacted]`),
    160,
  );
}

/* ------------------------------------------------------------------ *
 * Async failure handling
 * ------------------------------------------------------------------ */

interface BracketFrame {
  isTry: boolean;
}

export function findUnhandledAsync(
  path: string,
  content: string,
  language: Language,
  consideredLines: Set<number> | null,
): UnhandledAsync[] {
  if (language === "other") return [];
  // In test code, a rejected promise fails the test - that *is* the failure
  // handling, and asking for a try/catch around it would defeat the test. A
  // literal expected value in a test is not configuration either, so this matches
  // how the hardcoded-value check treats test files.
  if (isTestFile(path)) return [];
  const lines = linesOf(stripCode(content, language));
  const rawLines = linesOf(content);
  const findings: UnhandledAsync[] = [];
  const seenLines = new Set<number>();

  /**
   * Whether the enclosing function rethrows. When it does, the failure is being
   * surfaced deliberately, so the finding is recorded but not counted against
   * the change by the judge.
   */
  const propagatesFrom = (index: number): boolean =>
    RETHROW.test(lines.slice(Math.max(0, index - 40), index + 12).join("\n"));

  const record = (index: number, kind: AsyncGapKind, note: string): void => {
    const lineNumber = index + 1;
    if (consideredLines && !consideredLines.has(lineNumber)) return;
    if (seenLines.has(lineNumber)) return;
    seenLines.add(lineNumber);
    const propagates = propagatesFrom(index);
    findings.push({
      path,
      line: lineNumber,
      container: enclosingName(lines, index, language),
      excerpt: truncate(
        `${note}${(rawLines[index] ?? "").trim()}${propagates ? " (the enclosing function does rethrow)" : ""}`,
        200,
      ),
      kind,
      propagates,
    });
  };

  if (language === "python") {
    const frames: { indent: number; isTry: boolean }[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      while (frames.length > 0 && (frames[frames.length - 1]?.indent ?? -1) >= indent) frames.pop();
      if (TRY_BLOCK_PY.test(line)) {
        frames.push({ indent, isTry: true });
        continue;
      }
      if (frames.some((frame) => frame.isTry)) continue;
      if (AWAIT_CALL.test(line)) {
        record(index, "await_without_try", "await with no try/except: ");
        continue;
      }
      if (FALLIBLE_PY_CALL.test(line)) {
        record(index, "fallible_call_without_try", "fallible call with no try/except: ");
      }
    }
    return findings;
  }

  const stack: BracketFrame[] = [];
  let pendingTry = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (TRY_BLOCK_JS.test(line)) pendingTry = true;
    for (const char of line) {
      if (char === "{") {
        stack.push({ isTry: pendingTry });
        pendingTry = false;
      } else if (char === "}") {
        stack.pop();
      }
    }

    const hasAwait = AWAIT_CALL.test(line);
    const fallible = FALLIBLE_JS_CALL.test(line);
    // A promise whose result is discarded cannot report its failure to anyone.
    const isFloatingPromise = fallible && !/\bawait\b|\breturn\b/.test(line) && !/=\s*[^=]/.test(line);
    if (!hasAwait && !fallible) continue;
    if (stack.some((frame) => frame.isTry)) continue;
    if (CATCH_HANDLER.test(lines.slice(index, index + 4).join(" "))) continue;

    if (isFloatingPromise) {
      record(index, "floating_promise", "promise started with no await or catch: ");
    } else if (hasAwait) {
      record(index, "await_without_try", "await with no try/catch: ");
    } else {
      record(index, "fallible_call_without_try", "fallible call with no try/catch: ");
    }
  }

  return findings;
}

function enclosingName(lines: string[], index: number, language: Language): string {
  for (let cursor = index; cursor >= 0 && cursor > index - 60; cursor--) {
    const line = lines[cursor] ?? "";
    if (language === "python") {
      const definition = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
      if (definition?.[1]) return `${definition[1]}()`;
      continue;
    }
    const fn = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (fn?.[1]) return `${fn[1]}()`;
    const method =
      /^\s*(?:public|private|protected|static|async|readonly|\s)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^;{]+)?\{/.exec(line);
    if (method?.[1]) return `${method[1]}()`;
    const arrow =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/.exec(line);
    if (arrow?.[1]) return `${arrow[1]}()`;
  }
  return "the enclosing scope";
}

/* ------------------------------------------------------------------ *
 * Swallowed errors
 * ------------------------------------------------------------------ */

/**
 * Find catch/except clauses that swallow their error.
 *
 * Reported shapes:
 * - JS/TS: `catch {}`, `catch (e) {}`, and the opening line of a multi-line
 *   block whose body turns out to hold no statement.
 * - Python: `except: pass`, a bare `except:` with only a `pass` body, and
 *   `except Exception:` with only a `pass` body.
 *
 * Deliberately NOT reported: a clause that rethrows (propagation is a choice,
 * the same reasoning as `propagates` on async findings), or one that logs the
 * error — logging is a defensible minimal handling, and accusing it would be
 * noise. Such clauses are recorded with `partiallyHandled` so the judge can
 * weigh them without the feedback layer pretending they are silent.
 *
 * As with every detector here, this under-claims: a shape it cannot classify
 * confidently is skipped rather than accused.
 */
export function findSwallowedErrors(
  path: string,
  content: string,
  language: Language,
  consideredLines: Set<number> | null,
): SwallowedError[] {
  if (language === "other") return [];
  const lines = linesOf(stripCode(content, language));
  const rawLines = linesOf(content);
  const findings: SwallowedError[] = [];

  /** Shared sink: scope-filter, locate, and append one finding. */
  const record = (index: number, excerptNote: string, partiallyHandled: boolean): void => {
    const lineNumber = index + 1;
    if (consideredLines && !consideredLines.has(lineNumber)) return;
    findings.push({
      path,
      line: lineNumber,
      container: enclosingName(lines, index, language),
      excerpt: truncate(`${excerptNote}${(rawLines[index] ?? "").trim()}`, 160),
      partiallyHandled,
    });
  };

  if (language === "python") {
    scanPythonSwallowedErrors(lines, record);
  } else {
    scanJsSwallowedErrors(lines, rawLines, record);
  }
  return findings;
}

/** Callback that appends one swallowed-error finding, already scope-filtered. */
type SwallowedRecord = (index: number, excerptNote: string, partiallyHandled: boolean) => void;

function scanPythonSwallowedErrors(lines: string[], record: SwallowedRecord): void {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";

    // `except: pass` on one line. Checked before the clause gate, because a
    // one-line clause does not match the clause pattern (nothing after the
    // colon) and would otherwise be skipped entirely.
    if (/^\s*except\b[^:]*:\s*pass\s*$/.test(line)) {
      record(index, "except clause swallows the error: ", false);
      continue;
    }

    const clause = PY_EXCEPT_CLAUSE.exec(line);
    if (!clause) continue;
    const indent = line.length - line.trimStart().length;

    // Otherwise the body must be only `pass` (or comments) at a deeper indent.
    let bodyIsPass = false;
    let partiallyHandled = false;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const body = lines[cursor] ?? "";
      if (!body.trim()) continue;
      const bodyIndent = body.length - body.trimStart().length;
      if (bodyIndent <= indent) break; // left the clause
      if (PY_PASS.test(body)) {
        bodyIsPass = true;
        continue;
      }
      // A real statement: the clause handles its error somehow.
      if (PY_EXCEPT_HANDLES.test(body)) partiallyHandled = true;
      break;
    }

    if (bodyIsPass) {
      record(index, "except clause with only `pass` as its body: ", false);
    } else if (partiallyHandled) {
      // A clause whose body logs or rethrows: surfaced for the judge to
      // weigh, but filtered out of the damning fix list by the feedback
      // layer, because logging or propagating is a defensible choice.
      record(index, "except clause only logs or rethrows (weigh, not a defect): ", true);
    }
  }
}

function scanJsSwallowedErrors(lines: string[], rawLines: string[], record: SwallowedRecord): void {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!/\bcatch\b/.test(line)) continue;

    // One-line empty: `catch {}` or `catch (e) {}`.
    if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(line)) {
      record(index, "catch block swallows the error: ", false);
      continue;
    }

    // Multi-line: find the opening brace, then scan the body until it closes.
    const brace = line.indexOf("{");
    if (brace === -1) continue;
    const region = braceRegion(lines, index, brace);
    if (!region) continue; // unbalanced: skip

    classifyJsCatchBody(region, rawLines, record);
  }
}

/** The [start, end] line indices of a brace region opening at `startLine`. */
function braceRegion(lines: string[], startLine: number, braceOffset: number): { start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let cursor = startLine; cursor < lines.length; cursor++) {
    const scan = lines[cursor] ?? "";
    const from = cursor === startLine ? braceOffset : 0;
    for (let position = from; position < scan.length; position++) {
      if (scan[position] === "{") {
        depth++;
        if (depth === 1) start = cursor;
      } else if (scan[position] === "}") {
        depth--;
        if (depth === 0 && start !== -1) return { start, end: cursor };
      }
    }
  }
  return start !== -1 && end !== -1 ? { start, end } : null;
}

/**
 * Decide whether a JS catch body is empty, comment-only, or real. The RAW body
 * lines are analysed: the stripped view leaves residue where comments were
 * removed (e.g. `// x` becomes `/`), which would make a comment-only body look
 * like a statement. `stripCode` preserves line indices, so raw and stripped
 * regions align.
 */
function classifyJsCatchBody(
  region: { start: number; end: number },
  rawLines: string[],
  record: SwallowedRecord,
): void {
  const bodyLines = rawLines.slice(region.start + 1, region.end);
  const statementLines = bodyLines.filter((bodyLine) => {
    const withoutLineComment = bodyLine.replace(/\/\/.*$/, "");
    const withoutBlockComments = withoutLineComment.replace(/\/\*.*?\*\//g, "").trim();
    return withoutBlockComments.length > 0;
  });

  if (statementLines.length === 0 && bodyLines.some((bodyLine) => bodyLine.trim().length > 0)) {
    // Blank apart from comments: the block still swallows the error, but a
    // comment explaining why is defensible. Report it so the judge can weigh it.
    record(region.start, "catch block with only a comment as its body: ", true);
    return;
  }
  if (statementLines.length === 0) {
    record(region.start, "catch block swallows the error: ", false);
  }
}

/* ------------------------------------------------------------------ *
 * Function size
 * ------------------------------------------------------------------ */

interface CodeBlock {
  name: string;
  start: number;
  end: number;
  body: string;
}

function findBlocks(lines: string[], language: Language): CodeBlock[] {
  const blocks: CodeBlock[] = [];

  if (language === "python") {
    for (let index = 0; index < lines.length; index++) {
      const match = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(lines[index] ?? "");
      if (!match) continue;
      const indent = (match[1] ?? "").length;
      let end = index;
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const candidate = lines[cursor] ?? "";
        if (!candidate.trim()) continue;
        if (candidate.length - candidate.trimStart().length <= indent) break;
        end = cursor;
      }
      blocks.push({
        name: match[2] ?? "anonymous",
        start: index,
        end,
        body: lines.slice(index, end + 1).join("\n"),
      });
    }
    return blocks;
  }

  const starts: { name: string; line: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fn = /\b(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line);
    if (fn?.[1]) {
      starts.push({ name: fn[1], line: index });
      continue;
    }
    const method =
      /^\s*(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{)]*\)\s*(?::[^;{=]+)?\{/.exec(line);
    if (method?.[1]) {
      starts.push({ name: method[1], line: index });
      continue;
    }
    const arrow =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>\s*\{/.exec(line);
    if (arrow?.[1]) starts.push({ name: arrow[1], line: index });
  }

  for (const start of starts) {
    let depth = 0;
    let opened = false;
    let end = start.line;
    outer: for (let cursor = start.line; cursor < lines.length; cursor++) {
      for (const char of lines[cursor] ?? "") {
        if (char === "{") {
          depth++;
          opened = true;
        } else if (char === "}") {
          depth--;
          if (opened && depth <= 0) {
            end = cursor;
            break outer;
          }
        }
      }
      end = cursor;
    }
    if (!opened) continue;
    blocks.push({
      name: start.name,
      start: start.line,
      end,
      body: lines.slice(start.line, end + 1).join("\n"),
    });
  }

  return blocks;
}

export function findGodFunctions(
  path: string,
  content: string,
  language: Language,
  consideredLines: Set<number> | null,
): GodFunction[] {
  if (language === "other") return [];
  const lines = linesOf(stripCode(content, language));
  const results: GodFunction[] = [];
  for (const block of findBlocks(lines, language)) {
    const startLine = block.start + 1;
    if (consideredLines && !consideredLines.has(startLine)) continue;
    const length = block.end - block.start + 1;
    const branches = (block.body.match(/\b(?:if|elif|else\s+if|for|while|case|except|catch)\b|&&|\|\||\?\?/g) ?? []).length;
    if (length < MAX_FUNCTION_LINES && branches < MAX_FUNCTION_BRANCHES) continue;
    results.push({ path, name: block.name, startLine, length, branches });
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * Test signals
 * ------------------------------------------------------------------ */

const ASSERTION_PATTERNS: Record<"js" | "py", RegExp[]> = {
  js: [
    /\.toBe(?:Defined|Truthy|Falsy)?|\.toEqual|\.toStrictEqual|\.toThrow|\.toHaveBeenCalled|\.toMatch|\.toContain|\.rejects|\.resolves/g,
    /\bassert\s*\./g,
    /\bassert\s*\(/g,
    /\bexpect\s*\(/g,
  ],
  py: [/^\s*assert\b/gm, /\.assert\w+\s*\(/g, /pytest\.raises/g],
};

const TEST_CASE_START: Record<"js" | "py", RegExp> = {
  js: /\b(?:it|test)(?:\.\w+)?\s*\(/g,
  py: /^[ \t]*(?:async\s+)?def\s+test_[A-Za-z_]\w*/gm,
};

export function analyseTests(
  files: { path: string; content?: string; language: Language | null }[],
): TestSignals {
  const testFiles: string[] = [];
  const sourceFiles: string[] = [];
  const contents: string[] = [];
  let assertions = 0;
  let assertionlessTests = 0;
  let skippedTests = 0;
  let onlyTests = 0;

  for (const file of files) {
    if (isTestFile(file.path)) testFiles.push(file.path);
    else if (file.language !== "other") sourceFiles.push(file.path);
    if (file.content) contents.push(file.content);
  }

  const framework = detectTestFramework(testFiles, contents);

  for (const file of files) {
    if (!file.content || !isTestFile(file.path)) continue;
    const flavour: "js" | "py" = (file.language ?? detectLanguage(file.path)) === "python" ? "py" : "js";
    const code = stripCode(file.content, (file.language ?? detectLanguage(file.path)) ?? "javascript");

    for (const pattern of ASSERTION_PATTERNS[flavour]) {
      assertions += (code.match(pattern) ?? []).length;
    }
    skippedTests += countCaseModifiers(code, flavour, "skip");
    onlyTests += countCaseModifiers(code, flavour, "only");
    assertionlessTests += countAssertionlessCases(code, flavour);
  }

  return {
    testFilesChanged: testFiles,
    sourceFilesWithoutTests: testFiles.length === 0 ? sourceFiles : [],
    assertions,
    assertionlessTests,
    skippedTests,
    onlyTests,
    framework,
  };
}

function countCaseModifiers(code: string, flavour: "js" | "py", kind: "skip" | "only"): number {
  if (kind === "skip") {
    return (
      (code.match(/\.(?:skip|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/g) ?? []).length +
      (code.match(/@pytest\.mark\.(?:skip|xfail)|unittest\.skip/g) ?? []).length
    );
  }
  return (code.match(/\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/g) ?? []).length;
}

/**
 * Approximate: test cases are delimited by the start of the next case, so nested
 * `describe` blocks are attributed to the case they appear in. That is enough to
 * separate "tests exist" from "tests that check something".
 */
function countAssertionlessCases(code: string, flavour: "js" | "py"): number {
  const starts: number[] = [];
  const regex = new RegExp(TEST_CASE_START[flavour].source, TEST_CASE_START[flavour].flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) starts.push(match.index);
  if (starts.length === 0) return 0;

  let count = 0;
  for (let index = 0; index < starts.length; index++) {
    const body = code.slice(starts[index] ?? 0, starts[index + 1] ?? code.length);
    const hasAssertion = ASSERTION_PATTERNS[flavour].some((pattern) => {
      // Preserve the original flags: several of these are anchored with `^` and
      // carry `m`, and dropping it makes them match only at offset 0.
      const local = new RegExp(pattern.source, pattern.flags);
      local.lastIndex = 0;
      return local.test(body);
    });
    if (!hasAssertion && !/\.rejects|pytest\.raises/.test(body)) count++;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export interface AnalyseInput {
  files: ChangedFile[];
  /** Convention baseline sampled from the wider repository, when available. */
  baseline: StyleProfile | null;
}

export function analyseChanges(input: AnalyseInput): AnalysisReport {
  const { files, baseline } = input;

  const profiles: StyleProfile[] = [];
  const casingCandidates: { path: string; content: string; language: Language; consideredLines: Set<number> | null }[] = [];
  const risks: RiskFinding[] = [];
  const hardcoded: HardcodedFinding[] = [];
  const unhandledAsync: UnhandledAsync[] = [];
  const swallowedErrors: SwallowedError[] = [];
  const godFunctions: GodFunction[] = [];

  for (const file of files) {
    if (file.status === "deleted") continue;
    const language = file.language;
    if (!language || language === "other") continue;
    // Without a diff we cannot attribute lines to the change, so every line of
    // the submitted content is in scope. With a diff we can be exact.
    const considered = addedLineNumbers(file.diff);
    const content = file.content ?? "";
    if (!content.trim()) continue;

    profiles.push(profileSource(content, language));
    casingCandidates.push({ path: file.path, content, language, consideredLines: considered });
    risks.push(...findRisks(file.path, content, language, considered));
    hardcoded.push(...findHardcoded(file.path, content, language, considered));
    unhandledAsync.push(...findUnhandledAsync(file.path, content, language, considered));
    swallowedErrors.push(...findSwallowedErrors(file.path, content, language, considered));
    godFunctions.push(...findGodFunctions(file.path, content, language, considered));
  }

  const tests = analyseTests(
    files.map((file) => ({ path: file.path, content: file.content, language: file.language })),
  );

  return {
    newCode: mergeProfiles(profiles),
    repoBaseline: baseline,
    casingViolations: baseline ? findCasingViolations(casingCandidates, baseline) : [],
    risks,
    hardcoded,
    unhandledAsync,
    swallowedErrors,
    godFunctions,
    tests,
    totals: totalChanges(files),
  };
}

export function totalChanges(files: ChangedFile[]): ChangeTotals {
  const languages = new Set<Language>();
  let added = 0;
  let removed = 0;
  const newFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const file of files) {
    added += file.added;
    removed += file.removed;
    if (file.language) languages.add(file.language);
    if (file.status === "added") newFiles.push(file.path);
    if (file.status === "deleted") deletedFiles.push(file.path);
  }

  return { filesChanged: files.length, added, removed, newFiles, deletedFiles, languages: [...languages] };
}

/* ------------------------------------------------------------------ *
 * Human-readable summaries used by the feedback layer
 * ------------------------------------------------------------------ */

export function describeStyle(profile: StyleProfile): string {
  const parts: string[] = [];
  if (profile.dominantCasing) {
    parts.push(
      `${HUMAN_CASING[profile.dominantCasing]} naming (${Math.round(profile.casingConsistency * 100)}% of ${profile.identifiers} declarations)`,
    );
  }
  if (profile.indent) parts.push(`${profile.indent} indent`);
  if (profile.quoteStyle && profile.quoteStyle !== "mixed") parts.push(`${profile.quoteStyle} quotes`);
  if (profile.semicolons === "always" || profile.semicolons === "never") parts.push(`semicolons ${profile.semicolons}`);
  return parts.length > 0 ? parts.join(", ") : "no consistent style detected";
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
