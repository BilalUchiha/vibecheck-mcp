/**
 * Language-aware primitives shared by the static analyzer and the convention
 * sampler.
 *
 * Everything here is heuristic by design. The goal is not to be a parser: it is
 * to extract signals that are directionally reliable and cheap, then hand the
 * judgment to Jev. Where a heuristic can be wrong the code says so, because the
 * feedback layer must never state a guess as though it were a fact.
 *
 * Casing analysis counts *declarations only*, not every identifier. Property
 * accesses on third-party objects follow the third party's convention, and
 * counting them would blame the agent for someone else's style.
 *
 * A single lowercase word (`data`, `path`) is casing-neutral: it is valid in
 * both camelCase and snake_case code, so it discriminates nothing and is
 * excluded from the counts. The signal lives in `getUserData` vs
 * `get_user_data`.
 */

import type { CasingStyle, Language } from "../types.js";

/* ------------------------------------------------------------------ *
 * Language detection
 * ------------------------------------------------------------------ */

const EXTENSION_LANGUAGE: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
};

export function detectLanguage(filePath: string): Language | null {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  return EXTENSION_LANGUAGE[lower.slice(dot)] ?? "other";
}

export function isCodeLanguage(language: Language | null): boolean {
  return language === "typescript" || language === "javascript" || language === "python";
}

/** Languages the convention sampler and analyzer understand well. */
export const SUPPORTED_LANGUAGES: Language[] = ["typescript", "javascript", "python"];

/* ------------------------------------------------------------------ *
 * Test file detection
 * ------------------------------------------------------------------ */

const TEST_PATTERNS: RegExp[] = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)spec\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /(^|\/)conftest\.py$/,
];

export function isTestFile(filePath: string): boolean {
  const normalised = filePath.replace(/\\/g, "/");
  return TEST_PATTERNS.some((pattern) => pattern.test(normalised));
}

export function detectTestFramework(paths: string[], contents: string[]): string | null {
  const blob = paths.join("\n");
  const text = contents.join("\n");
  if (/\.py$/.test(blob) || /\bdef test_|\bimport pytest\b/.test(text)) {
    if (/\bimport pytest\b|@pytest\./.test(text)) return "pytest";
    return "unittest";
  }
  if (/\bimport\s+\{[^}]*\b(describe|it|expect|test)\b[^}]*\}\s+from\s+["'](vitest|@jest\/globals)/.test(text)) {
    return /vitest/.test(text) ? "vitest" : "jest";
  }
  if (/\brequire\(["'](node:)?assert["']\)|from\s+["'](node:)?assert["']/.test(text)) return "node:assert";
  if (/\bdescribe\(|\bit\(|\btest\(/.test(text)) return "jest-like";
  return null;
}

/* ------------------------------------------------------------------ *
 * Code stripping
 *
 * Comments and string bodies are blanked to spaces rather than deleted, so
 * every byte offset still maps to the original line number.
 * ------------------------------------------------------------------ */

const JS_KEYWORDS = new Set([
  "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class",
  "const", "constructor", "continue", "declare", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "from", "function", "get", "if", "implements",
  "import", "in", "instanceof", "interface", "is", "keyof", "let", "namespace", "new", "null",
  "number", "object", "of", "private", "protected", "public", "readonly", "return", "satisfies",
  "set", "static", "string", "super", "switch", "symbol", "this", "throw", "true", "try", "type",
  "typeof", "undefined", "unknown", "var", "void", "while", "with", "yield",
  "Array", "Boolean", "Error", "JSON", "Map", "Math", "Number", "Object", "Promise", "Set",
  "String", "console", "document", "globalThis", "process", "require", "window",
]);

const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
  "None", "nonlocal", "not", "or", "pass", "raise", "return", "self", "True", "False", "try",
  "while", "with", "yield", "print", "len", "str", "int", "float", "bool", "list", "dict", "set",
  "tuple", "range", "enumerate", "zip", "super", "type", "isinstance", "Exception",
]);

function isKeyword(name: string, language: Language): boolean {
  return language === "python" ? PY_KEYWORDS.has(name) : JS_KEYWORDS.has(name);
}

const CHAR_BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "*", "%", "<", ">", "~", "^"]);

export interface StripOptions {
  /** Replace comment bodies with spaces. Default true. */
  blankComments?: boolean;
  /** Replace string/regex bodies with spaces. Default true. */
  blankStrings?: boolean;
}

/**
 * Blank out comments and/or string bodies while preserving offsets, so line
 * numbers survive. Three views are used across the analyzer:
 *
 *   both blanked        - code structure, declarations, control flow
 *   keepStrings         - literals worth flagging (URLs, secrets, paths)
 *   keepComments        - markers that live in comments (TODO, @ts-ignore)
 */
export function stripCode(source: string, language: Language, options: StripOptions = {}): string {
  const blankComments = options.blankComments ?? true;
  const blankStrings = options.blankStrings ?? true;
  const chars = source.split("");
  const length = source.length;

  const blank = (from: number, to: number): void => {
    for (let k = Math.max(0, from); k < Math.min(length, to); k++) {
      const ch = chars[k];
      if (ch !== "\n" && ch !== "\r") chars[k] = " ";
    }
  };

  const at = (index: number): string => source[index] ?? "";

  let i = 0;
  let previousMeaningful = "";

  while (i < length) {
    const c = at(i);
    const next = at(i + 1);

    if (language === "python") {
      if (c === "#") {
        let j = i;
        while (j < length && at(j) !== "\n") j++;
        if (blankComments) blank(i + 1, j);
        i = j;
        continue;
      }
      const triple = source.startsWith('"""', i) || source.startsWith("'''", i);
      if (triple) {
        const quote = source.slice(i, i + 3);
        let j = source.indexOf(quote, i + 3);
        j = j === -1 ? length : j + 3;
        if (blankStrings) blank(i + 1, j);
        i = j;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < length) {
          const ch = at(j);
          if (ch === "\\") {
            j += 2;
            continue;
          }
          if (ch === c || ch === "\n") {
            j++;
            break;
          }
          j++;
        }
        if (blankStrings) blank(i + 1, j);
        i = j;
        continue;
      }
    } else {
      if (c === "/" && next === "/") {
        let j = i;
        while (j < length && at(j) !== "\n") j++;
        if (blankComments) blank(i + 1, j);
        i = j;
        continue;
      }
      if (c === "/" && next === "*") {
        let j = i + 2;
        while (j < length && !(at(j) === "*" && at(j + 1) === "/")) j++;
        const end = Math.min(length, j + 2);
        if (blankComments) blank(i + 1, end);
        i = end;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        let j = i + 1;
        while (j < length) {
          const ch = at(j);
          if (ch === "\\") {
            j += 2;
            continue;
          }
          if (ch === quote) {
            j++;
            break;
          }
          if (ch === "\n" && quote !== "`") break;
          j++;
        }
        if (blankStrings) blank(i + 1, j);
        i = j;
        continue;
      }
      // Regex-literal heuristic: a `/` in expression position opens a regex.
      // Without this, `/https?:\/\//` would look like a line comment.
      if (c === "/" && (previousMeaningful === "" || CHAR_BEFORE_REGEX.has(previousMeaningful))) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < length) {
          const ch = at(j);
          if (ch === "\\") {
            j += 2;
            continue;
          }
          if (ch === "\n") break;
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) {
            j++;
            closed = true;
            break;
          }
          j++;
        }
        if (closed) {
          if (blankStrings) blank(i + 1, j);
          i = j;
          continue;
        }
      }
    }

    if (!/\s/.test(c)) previousMeaningful = c;
    i++;
  }

  return chars.join("");
}

/* ------------------------------------------------------------------ *
 * Line helpers
 * ------------------------------------------------------------------ */

export function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

export function linesOf(source: string): string[] {
  return source.split(/\r?\n/);
}

/** Parse the added-line numbers out of a unified diff for a single file. */
export function addedLineNumbers(diff: string | undefined): Set<number> | null {
  if (!diff) return null;
  const added = new Set<number>();
  let newLine = 0;
  for (const raw of linesOf(diff)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      added.add(newLine);
      newLine++;
    } else if (raw.startsWith("-")) {
      // removals do not advance the new-file line counter
    } else if (raw.startsWith(" ")) {
      newLine++;
    }
  }
  return added;
}

/* ------------------------------------------------------------------ *
 * Casing
 * ------------------------------------------------------------------ */

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const PASCAL = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*$/;
const CAMEL = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/**
 * Classify a name. Returns `unknown` for casing-neutral names such as a single
 * lowercase word or a leading-underscore private name, which carry no signal
 * about the project's naming style.
 */
export function classifyCasing(name: string): CasingStyle {
  const bare = name.replace(/^_+/, "").replace(/_+$/, "");
  if (bare.length < 2) return "unknown";
  if (SCREAMING_SNAKE.test(bare)) return "SCREAMING_SNAKE_CASE";
  if (PASCAL.test(bare)) return "PascalCase";
  if (CAMEL.test(bare)) return "camelCase";
  if (SNAKE.test(bare)) return "snake_case";
  if (KEBAB.test(bare)) return "kebab-case";
  return "unknown";
}

/** Casing-neutral names tell us nothing about style, so they are not counted. */
export function isCasingSignal(name: string): boolean {
  return classifyCasing(name) !== "unknown";
}

export const HUMAN_CASING: Record<CasingStyle, string> = {
  snake_case: "snake_case",
  camelCase: "camelCase",
  PascalCase: "PascalCase",
  SCREAMING_SNAKE_CASE: "SCREAMING_SNAKE_CASE",
  "kebab-case": "kebab-case",
  unknown: "unclassified",
};

/* ------------------------------------------------------------------ *
 * Declaration extraction
 * ------------------------------------------------------------------ */

export type DeclarationRole = "function" | "class" | "type" | "variable" | "method" | "parameter";

export interface Declaration {
  name: string;
  line: number;
  role: DeclarationRole;
}

interface Pattern {
  regex: RegExp;
  role: DeclarationRole;
}

const JS_PATTERNS: Pattern[] = [
  { regex: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g, role: "function" },
  { regex: /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, role: "class" },
  { regex: /\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, role: "type" },
  { regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, role: "variable" },
  { regex: /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{)]*\)\s*(?::\s*[^;{=]+?)?\s*\{/gm, role: "method" },
  { regex: /\b(?:public|private|protected|readonly)\s+([A-Za-z_$][\w$]*)\s*[?!]?\s*:/g, role: "variable" },
];

const PY_PATTERNS: Pattern[] = [
  { regex: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, role: "function" },
  { regex: /^[ \t]*class\s+([A-Za-z_]\w*)/gm, role: "class" },
  { regex: /^[ \t]*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=/gm, role: "variable" },
  { regex: /^[ \t]*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(([^)]*)\)/gm, role: "parameter" },
];

/** Extract declared names with their line numbers from already-stripped code. */
export function extractDeclarations(stripped: string, language: Language): Declaration[] {
  const found: Declaration[] = [];
  const seen = new Set<string>();
  const patterns = language === "python" ? PY_PATTERNS : JS_PATTERNS;

  for (const { regex, role } of patterns) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(stripped)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      // Offset of the captured group within the file, so line numbers are real.
      const offset = match.index + match[0].indexOf(raw);
      if (role === "parameter") {
        for (const param of splitParams(raw)) push(param, offset, "parameter");
      } else {
        push(raw, offset, role);
      }
    }
  }

  // Arrow functions and callbacks: `const handler = (a, b) => ...`
  if (language !== "python") {
    const arrow =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/g;
    let match: RegExpExecArray | null;
    while ((match = arrow.exec(stripped)) !== null) {
      if (match[1]) push(match[1], match.index + match[0].indexOf(match[1]), "function");
      const params = match[2] ?? match[3] ?? "";
      for (const param of splitParams(params)) push(param, match.index, "parameter");
    }
  }

  return found;

  function push(name: string, offset: number, declarationRole: DeclarationRole): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!/^[A-Za-z_$][\w$-]*$/.test(trimmed)) return;
    if (isKeyword(trimmed, language)) return;
    if (trimmed.length < 3) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    found.push({ name: trimmed, line: lineNumberAt(stripped, offset), role: declarationRole });
  }
}

function splitParams(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((part) => {
      const withoutDefault = part.split("=")[0] ?? "";
      const withoutType = withoutDefault.split(":")[0] ?? "";
      return withoutType.replace(/[.{}\[\]*&<>?]/g, "").trim();
    })
    .filter(Boolean);
}

