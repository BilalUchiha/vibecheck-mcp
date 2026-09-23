/**
 * Git inspection.
 *
 * The server derives the change set from git rather than trusting the agent's
 * submitted payload, so that a self-report cannot omit the parts it would
 * rather not be judged on. The submitted payload is still accepted as a
 * fallback for directories that are not repositories, and the two can be
 * cross-checked.
 *
 * Nothing here mutates the repository: only read-only plumbing commands are
 * used, and `-c core.quotepath=false` keeps non-ASCII paths readable.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAX_FILE_BYTES, shouldSkipPath } from "./filters.js";
import type { ScopeConfig } from "../config.js";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: string[], timeoutMs = 15_000): GitResult {
  const result = spawnSync("git", ["-c", "core.quotepath=false", "--no-pager", ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export interface RepoInfo {
  /** Repo root from `git rev-parse --show-toplevel`. */
  topLevel: string;
  headSha: string | null;
  branch: string | null;
  /** The branch we diffed against, if one was found. */
  baseRef: string | null;
  /** True when the working tree has uncommitted changes. */
  dirty: boolean;
}

export function isGitRepo(cwd: string): boolean {
  return runGit(cwd, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
}

const CANDIDATE_BASES = ["origin/HEAD", "origin/main", "origin/master", "main", "master", "develop", "trunk"];

export function inspectRepo(cwd: string): RepoInfo | null {
  if (!isGitRepo(cwd)) return null;
  const topLevel = runGit(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim() || cwd;
  const headSha = runGit(cwd, ["rev-parse", "HEAD"]).stdout.trim() || null;
  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || null;
  const status = runGit(cwd, ["status", "--porcelain"]);
  const dirty = status.stdout.trim().length > 0;

  let baseRef: string | null = null;
  for (const candidate of CANDIDATE_BASES) {
    if (!runGit(cwd, ["rev-parse", "--verify", "--quiet", candidate]).ok) continue;
    const mergeBase = runGit(cwd, ["merge-base", "HEAD", candidate]);
    const sha = mergeBase.stdout.trim();
    // A merge base equal to HEAD means we are on the base branch itself, so
    // diffing against it would hide everything that is committed.
    if (sha && sha !== headSha) {
      baseRef = sha;
      break;
    }
    if (sha && !baseRef) baseRef = null;
  }

  return { topLevel, headSha, branch, baseRef, dirty };
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  diff: string;
  added: number;
  removed: number;
  binary: boolean;
  oldPath: string | null;
}

/** Split a unified diff into per-file sections. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  if (!text.trim()) return files;

  const lines = text.split("\n");
  let current: {
    header: string[];
    path: string;
    oldPath: string | null;
    status: FileDiff["status"];
    body: string[];
    /** True once the first hunk marker has been seen. */
    inBody: boolean;
    binary: boolean;
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    const diff = [...current.header, ...current.body].join("\n");
    let added = 0;
    let removed = 0;
    // Only the hunks count. The header's `+++ b/x` line also starts with `+`, so
    // counting the header would add one phantom line to every file.
    for (const line of current.body) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
    files.push({
      path: current.path,
      status: current.status,
      diff,
      added,
      removed,
      binary: current.binary,
      oldPath: current.oldPath,
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const parsed = parseDiffGitHeader(line);
      current = {
        header: [line],
        path: parsed?.path ?? "unknown",
        oldPath: parsed?.oldPath ?? null,
        status: "modified",
        body: [],
        inBody: false,
        binary: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length).trim();
    } else if (line.startsWith("rename to")) {
      current.path = line.slice("rename to ".length).trim();
    }
    // A binary file is reported with no hunk at all, so its marker has to be
    // caught before the header/body split rather than inside the body.
    if (line.startsWith("Binary files")) current.binary = true;
    // Everything before the first `@@` is metadata; from there on it is content.
    if (line.startsWith("@@")) current.inBody = true;
    if (current.inBody) current.body.push(line);
    else current.header.push(line);
  }
  flush();

  return files;
}

function parseDiffGitHeader(line: string): { path: string; oldPath: string } | null {
  const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
  if (!match?.[1] || !match[2]) return null;
  return { oldPath: match[1], path: match[2] };
}

export interface WorkingTreeEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath: string | null;
}

/** Parse `git status --porcelain` into entries, resolving rename notation. */
export function parseStatus(stdout: string): WorkingTreeEntry[] {
  const entries: WorkingTreeEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (!path) continue;
    let oldPath: string | null = null;
    const rename = /^(.+?) -> (.+)$/.exec(path);
    if (rename?.[1] && rename[2]) {
      oldPath = rename[1];
      path = rename[2];
    }
    let status: WorkingTreeEntry["status"];
    if (code.includes("?")) status = "added";
    else if (code.includes("R")) status = "renamed";
    else if (code.includes("A")) status = "added";
    else if (code.includes("D")) status = "deleted";
    else status = "modified";
    entries.push({ path, status, oldPath });
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Review scope
 * ------------------------------------------------------------------ *
 * Which commits a review covers is a correctness question, not a convenience
 * one. When the branch has a base to compare against, git answers it. When it
 * does not - an agent working straight on `main`, or a repository with a single
 * branch - git cannot say where the task began, and a wrong answer produces a
 * confident verdict about the wrong evidence: a task committed in three steps
 * looks like a one-file change, so the judge reports it as under-delivered.
 *
 * The scope is therefore chosen explicitly, disclosed in the verdict, and never
 * allowed to be narrower than the files the agent said it changed.
 */

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  /** Committer timestamp, epoch milliseconds. */
  timestamp: number;
}

interface CommitEntry {
  commit: GitCommit;
  /** Paths this commit touched, from `--name-only`. */
  paths: string[];
}

export type ScopeRule =
  /** The branch, against the merge-base with the repository's base branch. */
  | "branch-base"
  /** Uncommitted changes only; the project asked for this. */
  | "working-tree"
  /** The trailing run of commits inside the configured window. */
  | "recent-commits"
  /** Widened beyond the window to cover commits that touched reported files. */
  | "claimed-commits"
  /** Only the newest commit, because the project asked for that. */
  | "last-commit"
  /** No committed work could be attributed to the task. */
  | "none";

export interface ReviewScope {
  rule: ScopeRule;
  /** Commits included in the review, newest first. */
  commits: GitCommit[];
  /** What the diff was taken against, in plain language, for the verdict. */
  description: string;
  /** The commit window used to select work, in hours, when one applied. */
  windowHours: number | null;
}

/** Field separator for `git log --format`, chosen because it cannot occur in a path. */
const UNIT = "\u001f";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const COMMIT_FORMAT = `--format=${UNIT}%H${UNIT}%h${UNIT}%ct${UNIT}%s`;

const DEFAULT_SCOPE: ScopeConfig = { mode: "auto", maxCommits: 20, maxAgeHours: 12 };

/** Milliseconds in an hour, for converting the configured window into a cutoff. */
const MS_PER_HOUR = 3_600_000;

function parseCommitLine(line: string): GitCommit | null {
  const [, sha, shortSha, epoch, ...rest] = line.split(UNIT);
  if (!sha || !shortSha || !epoch) return null;
  const seconds = Number(epoch);
  if (!Number.isFinite(seconds)) return null;
  return { sha, shortSha, subject: rest.join(UNIT), timestamp: seconds * 1000 };
}

function collectCommitLines(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(UNIT)) continue;
    const commit = parseCommitLine(line);
    if (commit) commits.push(commit);
  }
  return commits;
}

/** Commits reachable in `range` (e.g. `abc123..HEAD`), newest first. */
export function listCommitsInRange(cwd: string, range: string, maxCount: number): GitCommit[] {
  const result = runGit(cwd, ["log", "-n", String(Math.max(1, maxCount)), COMMIT_FORMAT, range]);
  return result.ok ? collectCommitLines(result.stdout) : [];
}

/**
 * The newest commits, newest first, each with the paths it touched.
 *
 * One `git log` call answers "has anything recent touched this file?" for every
 * reported file at once, so claim-driven widening costs no extra process spawns.
 */
export function listCommitHistory(cwd: string, maxCount: number): CommitEntry[] {
  const result = runGit(cwd, ["log", "-n", String(Math.max(1, maxCount)), COMMIT_FORMAT, "--name-only"]);
  if (!result.ok) return [];

  const commits: CommitEntry[] = [];
  let current: CommitEntry | null = null;
  for (const raw of result.stdout.split("\n")) {
    if (raw.startsWith(UNIT)) {
      const commit = parseCommitLine(raw);
      current = commit ? { commit, paths: [] } : null;
      if (current) commits.push(current);
      continue;
    }
    const touched = raw.trim();
    if (current && touched) current.paths.push(touched);
  }
  return commits;
}

/** The newest commit that touched `path`, or null when git has no record of one. */
export function lastCommitTouching(cwd: string, filePath: string): GitCommit | null {
  const result = runGit(cwd, ["log", "-n", "1", COMMIT_FORMAT, "--", filePath]);
  if (!result.ok) return null;
  return collectCommitLines(result.stdout)[0] ?? null;
}

/**
 * A revision that diffs `sha` and everything after it, or null when `sha` is a
 * root commit and therefore has no "before" to diff against.
 */
function parentRev(cwd: string, sha: string): string | null {
  const parent = runGit(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^`]);
  const value = parent.stdout.trim();
  return parent.ok && value ? value : null;
}

interface CommittedScopePlan {
  scope: ReviewScope;
  fromRev: string;
  /** null diffs against the working tree instead of a commit. */
  toRev: string | null;
}

/**
 * Choose the commits a review covers when this branch has no base to compare
 * against.
 *
 * The age window is a lower bound, never a ceiling: any file the agent reported
 * changing pulls in the commit that last touched it, so a long session cannot be
 * truncated by the clock. Commits the window misses and no claim reaches are
 * named in `unreachedClaims` rather than silently dropped.
 */
function planCommittedScope(options: {
  topLevel: string;
  claimedPaths: string[];
  settings: ScopeConfig;
  includeWorkingTree: boolean;
}): CommittedScopePlan | null {
  const { topLevel, claimedPaths, settings } = options;
  const history = listCommitHistory(topLevel, Math.max(1, settings.maxCommits));
  const newest = history[0];
  if (!newest) return null;

  const cutoff = Date.now() - settings.maxAgeHours * MS_PER_HOUR;
  const chosen = new Set<number>();
  let windowDeepest = -1;

  if (settings.mode === "last-commit") {
    chosen.add(0);
  } else {
    history.forEach((entry, index) => {
      if (entry.commit.timestamp < cutoff) return;
      chosen.add(index);
      windowDeepest = Math.max(windowDeepest, index);
    });
  }

  // Claims widen the range; they never narrow it. A claim that cannot be placed
  // is reconciled by the caller, which knows whether git has a record of the file
  // at all and so can tell an out-of-scope report from a false one.
  let widenedByClaims = false;
  if (settings.mode === "auto" && claimedPaths.length > 0) {
    const remaining = new Set(claimedPaths);
    history.forEach((entry, index) => {
      for (const touched of entry.paths) {
        if (!remaining.delete(touched)) continue;
        chosen.add(index);
        if (index > windowDeepest) widenedByClaims = true;
      }
    });
  }

  let deepest = chosen.size > 0 ? Math.max(...chosen) : 0;

  // A root commit has no "before". Diffing from the empty tree would present the
  // whole repository as the change, which is both wrong and self-defeating: the
  // convention baseline would then be sampled from the change itself. So the
  // scope stops at the last commit that has a parent, and a repository with a
  // single commit has no committed scope to review at all.
  let fromRev = parentRev(topLevel, history[deepest]?.commit.sha ?? "");
  while (deepest > 0 && fromRev === null) {
    deepest -= 1;
    fromRev = parentRev(topLevel, history[deepest]?.commit.sha ?? "");
  }
  if (fromRev === null) return null;
  // Excluding the root commit can undo the widening the claims asked for; the
  // rule reported in the verdict must describe the range actually reviewed.
  if (deepest <= windowDeepest) widenedByClaims = false;

  const oldest = history[deepest] ?? newest;
  const span = Math.min(deepest + 1, history.length);
  const range = span === 1 ? newest.commit.shortSha : `${newest.commit.shortSha}..${oldest.commit.shortSha}`;
  const workingTree = options.includeWorkingTree ? " plus the uncommitted changes in the working tree" : "";

  let rule: ScopeRule;
  let description: string;
  if (settings.mode === "last-commit") {
    rule = "last-commit";
    description = `the most recent commit (${newest.commit.shortSha})${workingTree}`;
  } else if (widenedByClaims) {
    rule = "claimed-commits";
    description = `${span} commit(s) (${range})${workingTree}: widened beyond the last ${settings.maxAgeHours}h to cover the commits that touched the files you reported changing`;
  } else {
    rule = "recent-commits";
    description =
      `the last ${span} commit(s) (${range})${workingTree}` +
      (options.includeWorkingTree
        ? ""
        : `; the working tree is clean and this branch has no base to compare against, so the trailing run of commits is treated as the task`);
  }

  return {
    scope: {
      rule,
      commits: history.slice(0, span).map((entry) => entry.commit),
      description,
      windowHours: settings.mode === "auto" ? settings.maxAgeHours : null,
    },
    fromRev,
    toRev: options.includeWorkingTree ? null : "HEAD",
  };
}

export interface GitChangeSet {
  repo: RepoInfo;
  entries: WorkingTreeEntry[];
  diffs: Map<string, FileDiff>;
  /** Human-readable description of what the diff was taken against. */
  baseDescription: string;
  /** How the reviewed range was chosen, and what it contains. */
  scope: ReviewScope;
  /** Set when the diff could not be produced. */
  error: string | null;
  /** Non-fatal problems worth surfacing to the agent. */
  warnings: string[];
}

export interface CollectGitOptions {
  /**
   * Paths the agent reported changing. Used to *widen* the scope, never to
   * narrow it: a change the server cannot see is the server's problem to solve,
   * not a reason to judge a fraction of the work.
   */
  claimedPaths?: string[];
  scope?: ScopeConfig;
}

/**
 * Collect the change set for a repository: committed work on this branch since
 * it diverged from the base, plus uncommitted and untracked changes.
 */
export function collectGitChangeSet(
  cwd: string,
  maxFiles: number,
  options: CollectGitOptions = {},
): GitChangeSet | null {
  const repo = inspectRepo(cwd);
  if (!repo) return null;

  const settings = options.scope ?? DEFAULT_SCOPE;
  const claimedPaths = (options.claimedPaths ?? []).filter((claimed) => claimed.length > 0);

  const statusEntries = parseStatus(runGit(repo.topLevel, ["status", "--porcelain"]).stdout)
    .filter((entry) => !shouldSkipPath(entry.path));

  const warnings: string[] = [];
  let diffText = "";
  let fromRev: string;
  let toRev: string | null = null;
  let error: string | null = null;
  let scope: ReviewScope;

  if (repo.baseRef) {
    const commits = listCommitsInRange(repo.topLevel, `${repo.baseRef}..HEAD`, 200);
    scope = {
      rule: "branch-base",
      commits,
      description: `the branch since it diverged from its base (merge-base ${repo.baseRef.slice(0, 12)})${
        commits.length > 0 ? `, ${commits.length} commit(s)` : ""
      }`,
      windowHours: null,
    };
    fromRev = repo.baseRef;
  } else if (settings.mode === "working-tree") {
    scope = {
      rule: "working-tree",
      commits: [],
      description: "the uncommitted changes in the working tree",
      windowHours: null,
    };
    fromRev = repo.headSha ?? EMPTY_TREE;
  } else {
    const plan = planCommittedScope({
      topLevel: repo.topLevel,
      claimedPaths,
      settings,
      includeWorkingTree: statusEntries.length > 0,
    });
    if (plan) {
      scope = plan.scope;
      fromRev = plan.fromRev;
      toRev = plan.toRev;
    } else {
      // No commit to attribute to the task, so the uncommitted work is all there
      // is. The caller falls back to the agent's own description and says so.
      scope = {
        rule: "none",
        commits: [],
        description: "the uncommitted changes in the working tree",
        windowHours: null,
      };
      fromRev = repo.headSha ?? EMPTY_TREE;
    }
  }

  const diffArgs = ["diff", "--no-color", "-M", "-U3", fromRev, ...(toRev ? [toRev] : []), "--"];
  const diff = runGit(repo.topLevel, diffArgs);
  if (diff.ok) {
    diffText = diff.stdout;
  } else {
    error = `git diff ${fromRev}${toRev ? ` ${toRev}` : ""} failed: ${diff.stderr.trim()}`;
  }



  const parsed = parseUnifiedDiff(diffText);
  for (const file of parsed) {
    if (file.status === "renamed" && file.oldPath) {
      const entry = statusEntries.find((candidate) => candidate.oldPath === file.oldPath);
      if (entry) entry.status = "renamed";
    }
  }

  const diffs = new Map<string, FileDiff>();
  for (const file of parsed) {
    if (shouldSkipPath(file.path)) continue;
    diffs.set(file.path, file);
  }

  // Untracked files never appear in `git diff`, so they are added explicitly.
  const untracked = statusEntries.filter(
    (entry) => entry.status === "added" && !diffs.has(entry.path),
  );
  const limited = untracked.slice(0, Math.max(0, maxFiles - diffs.size));
  const baseDescription = scope.description;

  return {
    repo,
    entries: [...diffs.keys()].map((path) => {
      const existing = statusEntries.find((entry) => entry.path === path);
      return existing ?? { path, status: diffs.get(path)?.status ?? "modified", oldPath: null };
    }).concat(limited),
    diffs,
    baseDescription,
    scope,
    error,
    warnings,
  };
}

export interface FileContent {
  content: string | null;
  truncated: boolean;
  bytes: number;
}

export function readRepoFile(topLevel: string, relativePath: string): FileContent {
  // Resolve inside the repo only, so a `..` path cannot escape it.
  const absolute = path.resolve(topLevel, relativePath);
  const relativeToRoot = path.relative(topLevel, absolute);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return { content: null, truncated: false, bytes: 0 };
  }
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return { content: null, truncated: false, bytes: 0 };
    if (stat.size <= MAX_FILE_BYTES) {
      return { content: fs.readFileSync(absolute, "utf8"), truncated: false, bytes: stat.size };
    }
    const handle = fs.openSync(absolute, "r");
    try {
      const buffer = Buffer.alloc(MAX_FILE_BYTES);
      const read = fs.readSync(handle, buffer, 0, MAX_FILE_BYTES, 0);
      return { content: buffer.subarray(0, read).toString("utf8"), truncated: true, bytes: stat.size };
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return { content: null, truncated: false, bytes: 0 };
  }
}

/** Tracked files, honouring .gitignore, newest commit first. */
export function listTrackedFiles(cwd: string, recencyWindow = 400): string[] {
  const result = runGit(cwd, ["log", "--name-only", "--pretty=format:", "-n", String(recencyWindow)]);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const source = result.ok && result.stdout.trim() ? result.stdout.split("\n") : [];
  for (const line of source) {
    const path = line.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    ordered.push(path);
  }
  if (ordered.length > 0) return ordered;

  // A repository with no commits yet: fall back to the index/working tree.
  const fallback = runGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  return fallback.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
