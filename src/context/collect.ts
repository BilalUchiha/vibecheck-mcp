/**
 * Change-set collection.
 *
 * Preferred path: ask git. The agent's own description of what it changed is
 * treated as a claim to be checked, not as the evidence itself. Where git is
 * unavailable (not a repository) the submitted payload is used, and the verdict
 * records that its evidence is agent-reported, so the user can weigh it
 * accordingly.
 */

import fs from "node:fs";
import path from "node:path";
import { detectLanguage, isTestFile, linesOf } from "./lang.js";
import { shouldSkipPath } from "./filters.js";
import {
  collectGitChangeSet,
  parseStatus,
  readRepoFile,
  runGit,
  type RepoInfo,
} from "./git.js";
import type { ChangedFile, TestResults } from "../types.js";

export interface SubmittedFile {
  path: string;
  diff?: string;
  content?: string;
}

export interface Mismatch {
  /** The agent claimed a file changed that git does not see as changed. */
  claimedButUnchanged: string[];
  /** Git sees a change the agent did not mention. */
  changedButUnclaimed: string[];
}

export interface CollectionResult {
  files: ChangedFile[];
  evidenceSource: "git" | "submitted";
  repo: RepoInfo | null;
  baseDescription: string | null;
  mismatch: Mismatch | null;
  warnings: string[];
}

export function normalisePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

export function collectChangedFiles(options: {
  projectRoot: string;
  submitted: SubmittedFile[];
  maxFiles: number;
}): CollectionResult {
  const { projectRoot, submitted, maxFiles } = options;
  const warnings: string[] = [];
  const changeSet = collectGitChangeSet(projectRoot, maxFiles);

  if (changeSet) {
    if (changeSet.error) warnings.push(changeSet.error);
    const files: ChangedFile[] = [];

    for (const entry of changeSet.entries) {
      const normalised = normalisePath(entry.path);
      if (!normalised || shouldSkipPath(normalised)) continue;
      const diff = changeSet.diffs.get(entry.path);
      const onDisk =
        entry.status === "deleted" ? { content: null, truncated: false, bytes: 0 } : readRepoFile(changeSet.repo.topLevel, normalised);
      if (onDisk.truncated) {
        warnings.push(`${normalised} is larger than 400KB and was read partially`);
      }
      const content = onDisk.content;
      const derived = diff ? { added: diff.added, removed: diff.removed } : countLinesFromContent(content, entry.status);
      files.push({
        path: normalised,
        status: diff?.status ?? entry.status,
        diff: diff?.diff,
        content: content ?? undefined,
        added: derived.added,
        removed: derived.removed,
        language: detectLanguage(normalised),
        source: "git",
      });
    }

    if (files.length > 0 || submitted.length === 0) {
      const gitPaths = new Set(files.map((file) => file.path));
      const submittedPaths = new Set(
        submitted.map((file) => normalisePath(file.path)).filter((file) => file.length > 0),
      );
      const claimedButUnchanged = [...submittedPaths].filter((file) => !gitPaths.has(file));
      const changedButUnclaimed = [...gitPaths].filter((file) => !submittedPaths.has(file));

      const mismatch: Mismatch | null =
        claimedButUnchanged.length > 0 || changedButUnclaimed.length > 0
          ? { claimedButUnchanged, changedButUnclaimed }
          : null;

      return {
        files,
        evidenceSource: "git",
        repo: changeSet.repo,
        baseDescription: changeSet.baseDescription,
        mismatch,
        warnings,
      };
    }

    // Git knows about this repository but sees no change, while the agent
    // reported one. Reviewing nothing would silently pass an unreviewed change,
    // so the submission is used and the verdict says whose word it rests on.
    warnings.push(
      "git reports no changes for this project, so the agent's own description of the change set is being used instead",
    );
  }

  // Not a git repository (or git is unavailable): fall back to what was sent.
  if (!changeSet && runGit(projectRoot, ["rev-parse"]).stderr.includes("not a git repository")) {
    warnings.push("project_root is not a git repository; the submitted change set is being trusted as-is");
  }

  const files: ChangedFile[] = [];
  for (const file of submitted.slice(0, maxFiles)) {
    const normalised = normalisePath(file.path);
    if (!normalised) continue;
    const fromDisk = readSubmittedContent(projectRoot, normalised);
    const content = file.content ?? fromDisk ?? undefined;
    const derived = countLinesFromContent(content ?? null, "modified");
    files.push({
      path: normalised,
      status: "modified",
      diff: file.diff,
      content,
      added: derived.added,
      removed: derived.removed,
      language: detectLanguage(normalised),
      source: "submitted",
    });
  }

  return {
    files,
    evidenceSource: "submitted",
    repo: null,
    baseDescription: null,
    mismatch: null,
    warnings,
  };
}

function readSubmittedContent(projectRoot: string, relativePath: string): string | null {
  const absolute = path.resolve(projectRoot, relativePath);
  const relativeToRoot = path.relative(projectRoot, absolute);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) return null;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 400_000) return null;
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function countLinesFromContent(
  content: string | null,
  status: ChangedFile["status"],
): { added: number; removed: number } {
  if (status === "deleted") return { added: 0, removed: 0 };
  if (!content) return { added: 0, removed: 0 };
  return { added: linesOf(content).length, removed: 0 };
}

/** All paths git currently reports as changed, for diagnostic purposes. */
export function listGitChangedPaths(projectRoot: string): string[] {
  const status = runGit(projectRoot, ["status", "--porcelain"]);
  if (!status.ok) return [];
  return parseStatus(status.stdout).map((entry) => normalisePath(entry.path));
}

/* ------------------------------------------------------------------ *
 * Test result parsing
 * ------------------------------------------------------------------ */

const FAIL_PATTERNS: RegExp[] = [
  /\b(\d+)\s+fail(?:ed|ing|ures?)\b/i,
  /^FAIL\b/m,
  /\bAssertionError\b/,
  /\b\d+\s+tests?\s+failed\b/i,
  /#\s*fail\s+(\d+)/,
  /✕|✗|×/,
];

const PASS_COUNT_PATTERNS: RegExp[] = [
  /\b(\d+)\s+pass(?:ed|ing)\b/i,
  /#\s*pass\s+(\d+)/,
  /\bok\s+\d+\b/i,
];

const SUMMARY_PATTERNS: RegExp[] = [
  /^Tests:\s.*$/im,
  /^Test Suites:\s.*$/im,
  /^={2,}.*(?:passed|failed).*={2,}$/im,
  /^#\s*(?:tests|pass|fail)\s+\d+.*$/im,
  /^\d+\s+(?:passed|failed).*$/im,
  /\bRan \d+ tests? in\b.*$/m,
  /\d+\s+passed,\s*\d+\s+failed.*$/im,
];

export function parseTestResults(input: unknown): TestResults | null {
  if (input === undefined || input === null) return null;

  let raw: string;
  let structuredPassed: boolean | null = null;
  let structuredFailures: number | null = null;
  let structuredFramework: string | null = null;

  if (typeof input === "string") {
    raw = input;
  } else if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.passed === "boolean") structuredPassed = record.passed;
    if (typeof record.failures === "number") structuredFailures = record.failures;
    if (typeof record.failureCount === "number") structuredFailures = record.failureCount;
    if (typeof record.framework === "string") structuredFramework = record.framework;
    const output = record.output ?? record.stdout ?? record.summary ?? record.text ?? record.raw;
    raw =
      typeof output === "string"
        ? output
        : `${JSON.stringify(record, null, 2)}`; // best effort: keep the shape visible to Jev
  } else {
    return null;
  }

  if (!raw.trim()) return null;

  let failures = structuredFailures;
  if (failures === null) {
    for (const pattern of FAIL_PATTERNS) {
      const match = pattern.exec(raw);
      if (!match) continue;
      const count = match[1] ? Number(match[1]) : NaN;
      failures = Number.isFinite(count) ? count : 1;
      if (failures > 0) break;
    }
  }

  let passedCount = 0;
  for (const pattern of PASS_COUNT_PATTERNS) {
    const match = pattern.exec(raw);
    const count = match?.[1] ? Number(match[1]) : NaN;
    if (Number.isFinite(count)) passedCount = Math.max(passedCount, count);
  }

  let passed = structuredPassed;
  if (passed === null && failures !== null) passed = failures === 0;
  if (passed === null && passedCount > 0) passed = true;

  const summaryLine =
    SUMMARY_PATTERNS.map((pattern) => pattern.exec(raw)?.[0]?.trim()).find((line) => Boolean(line)) ?? null;

  const framework =
    structuredFramework ??
    detectFrameworkFromOutput(raw);

  return {
    raw,
    passed,
    framework,
    failures,
    summaryLine,
  };
}

function detectFrameworkFromOutput(raw: string): string | null {
  if (/^Test Suites:|^\s*PASS\s+\S+\.test\.|jest/i.test(raw)) return "jest";
  if (/vitest/i.test(raw)) return "vitest";
  if (/=\s*\d+ failed.*=\s*\d+ passed.*=/s.test(raw) || /platform (?:linux|darwin|win32)/i.test(raw)) return "pytest";
  if (/^\s*#\s*(?:tests|pass|fail)\s+\d+/m.test(raw)) return "node:test";
  if (/^\s*--- FAIL|^ok\s+\S+/m.test(raw)) return "go test";
  if (/^Ran \d+ tests? in/m.test(raw)) return "unittest";
  return null;
}

/** True when the change set contains no testable code (docs/config only). */
export function isDocsOrConfigOnly(files: ChangedFile[]): boolean {
  if (files.length === 0) return false;
  return files.every((file) => {
    const language = file.language;
    if (language === "typescript" || language === "javascript" || language === "python") {
      return isTestFile(file.path);
    }
    return true;
  });
}
