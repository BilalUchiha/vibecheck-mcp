/**
 * Call-detection patterns.
 *
 * These live in their own module because they are the most escape-sensitive
 * code in the project, and a single wrong backslash turns a detector into a
 * no-op that fails silently: the review simply stops noticing a whole class of
 * problem, and nothing appears to be broken.
 *
 * `test/patterns.test.ts` asserts every pattern here against a representative
 * sample, so an escaping mistake fails the suite loudly instead of quietly
 * weakening the review.
 */

/** Matches a call that can realistically fail at runtime. */
export const FALLIBLE_JS_CALL = /(?:\bfetch\s*\(|\baxios\.\w+\s*\(|\bJSON\.parse\s*\(|\.json\s*\(\s*\)|\breadFileSync\b|\bwriteFileSync\b|\bcreateConnection\s*\(|\batob\s*\(|\bcreateReadStream\s*\()/;

export const FALLIBLE_PY_CALL = /\b(?:requests\.(?:get|post|put|patch|delete|request|Session)|urlopen|json\.load|json\.loads|subprocess\.\w+|os\.remove|os\.makedirs|socket\.\w+|open)\s*\(/;

/** Matches an awaited call or an explicit await keyword. */
export const AWAIT_CALL = /\bawait\b|\basyncio\.(?:gather|wait)\b/;

/** Matches a rethrow, which means a failure may be surfaced deliberately. */
export const RETHROW = /\bthrow\b|\braise\b|(?:^|\s)reject\s*\(/;

/** A promise opted out of handling via `.catch(...)`. */
export const CATCH_HANDLER = /\.catch\s*\(|\.then\s*\([^)]*,\s*\w+\s*\)/;

/** `try {` in JS/TS or `try:` in Python. */
export const TRY_BLOCK_JS = /\btry\b/;
export const TRY_BLOCK_PY = /^\s*try\s*:/;

/** An empty catch block, which turns a loud failure into a silent one. */
export const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/;

/**
 * A catch clause whose body does nothing meaningful: empty, a lone comment
 * (comments are stripped before matching), or just `pass` in Python. Matched
 * line-by-line against stripped code, so a one-line `catch {}` and the closing
 * line of a multi-line empty block are both found.
 */
export const EMPTY_CATCH_LINE =
  /(?:catch\s*(?:\([^)]*\))?\s*\{\s*\}|catch\s*(?:\([^)]*\))?\s*\{$|^\s*(?:except\s*:\s*pass\s*|except\s*:\s*$|pass\s*$))/;

/** Opens a Python except clause, possibly with a captured name. */
export const PY_EXCEPT_CLAUSE = /^\s*except\b[^:]*:\s*(?:#.*)?$/;

/** A Python `pass` statement, the body of a swallowed except. */
export const PY_PASS = /^\s*pass\s*(?:#.*)?$/;

/** A Python except clause that already handles the error: rethrows or logs. */
export const PY_EXCEPT_HANDLES = /\braise\b|\bprint\s*\(|\blogger\b|\blogging\.|\blog\.|\blogging\.\w+|\.exception\s*\(|\.warning\s*\(|\.error\s*\(|\.info\s*\(/;

/** Network calls that ought to carry a timeout. */
export const NETWORK_CALL = /\b(?:fetch|axios|requests\.|http\.request|urlopen)\s*\(/;

/** Values arriving from outside the programme, which must be validated. */
export const UNTRUSTED_INPUT =
  /JSON\.parse\s*\(|\breq\.(?:body|query|params)\b|\brequest\.(?:json|form|args|get_json)\b|\bsys\.argv\b|\binput\s*\(|\bos\.environ\b/;

/**
 * Words that suggest a number should be configuration. Matched against the
 * individual words of an identifier, so `retryDelayMs` and `base_delay_ms` both
 * match while `admin` does not.
 */
export const TUNABLE_WORDS = new Set([
  "timeout",
  "delay",
  "interval",
  "limit",
  "max",
  "maximum",
  "min",
  "minimum",
  "size",
  "count",
  "retries",
  "retry",
  "ttl",
  "buffer",
  "capacity",
  "threshold",
  "backoff",
  "batch",
  "page",
  "period",
  "duration",
  "expires",
  "expiry",
  "quota",
  "rate",
  "port",
]);

/** Namespaces whose URLs carry no environment-specific meaning. */
export const BENIGN_URL = /^https?:\/\/(?:www\.)?(?:w3\.org|schema\.org|json-schema\.org|example\.(?:com|org|net)|localhost:0)[/"'`]?/i;

/** Values that look like credentials but are demonstrably placeholders. */
export const PLACEHOLDER_VALUE =
  /(?:process\.env|os\.environ|getenv|your[_-]?|xxx+|change[_-]?me|placeholder|redacted|\$\{|<[^>]*>|dummy|sample|fake|test[_-]?key|abc123|hunter2)/i;

export const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|secret|password|passwd|pwd|token|access[_-]?key|client[_-]?secret|auth[_-]?key)\s*[:=]\s*["'`]([^"'`\n]{8,})["'`]/i,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pous]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/,
];

/* ------------------------------------------------------------------ *
 * Identifier words
 * ------------------------------------------------------------------ */

/**
 * Split an identifier into lowercase words, breaking on camelCase humps,
 * underscores, hyphens and any other non-alphanumeric character.
 *
 * Used both to decide whether a number looks tunable and to rename identifiers
 * into a target casing, so the two always agree.
 */
export function identifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** True when any word of the text suggests configurability. */
export function mentionsTunableName(text: string): boolean {
  for (const word of identifierWords(text)) {
    if (TUNABLE_WORDS.has(word)) return true;
  }
  return false;
}

/**
 * True when a line merely gives a number a name, as in
 * `const retryDelayMs = 30000;`, `timeoutMs: 5_000,` or `retry_delay_ms = 30000`.
 *
 * Naming a number is the *fix* for a magic number, so these lines are exempt
 * from the magic-number check.
 */
export function isNamedConstantLine(line: string): boolean {
  const DECLARATION = /^\s*(?:export\s+)?(?:(?:const|let|var|final|readonly|static)\s+)?[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*-?\d[\d_.]*\s*;?\s*$/;
  const PROPERTY = /^\s*[A-Za-z_$][\w$]*\s*:\s*-?\d[\d_.]*\s*,?\s*$/;
  const KEYWORD_ARG = /^\s*(?:[\w.]+\s*\.\s*)?[A-Za-z_$][\w$]*\s*=\s*-?\d[\d_.]*\s*,?\s*$/;
  return DECLARATION.test(line) || PROPERTY.test(line) || KEYWORD_ARG.test(line);
}

/** Numbers, tolerating digit separators such as `30_000`. */
export const NUMBER_LITERAL = /\d[\d_]*(?:\.\d[\d_]*)?/g;

/** Find numbers worth reporting in a line of code. */
export function tunableNumbersIn(line: string): string[] {
  const found: string[] = [];
  for (const value of line.match(NUMBER_LITERAL) ?? []) {
    const numeric = Number(value.replace(/_/g, ""));
    if (!Number.isFinite(numeric)) continue;
    // A four-digit value in the year range is far more likely to be a date.
    if (numeric >= 1900 && numeric <= 2099) continue;
    if (numeric < 100) continue;
    found.push(value);
  }
  return found;
}
