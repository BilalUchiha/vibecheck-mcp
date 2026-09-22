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
  let current: { header: string[]; path: string; oldPath: string | null; status: FileDiff["status"]; body: string[] } | null =
    null;

  const flush = (): void => {
    if (!current) return;
    const diff = [...current.header, ...current.body].join("\n");
    let added = 0;
    let removed = 0;
    let binary = false;
    for (const line of current.body) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
      else if (line.startsWith("Binary files")) binary = true;
    }
    files.push({
      path: current.path,
      status: current.status,
      diff,
      added,
      removed,
      binary,
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
    current.header.push(line);
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

export interface GitChangeSet {
  repo: RepoInfo;
  entries: WorkingTreeEntry[];
  diffs: Map<string, FileDiff>;
  /** Human-readable description of what the diff was taken against. */
  baseDescription: string;
  /** Set when the diff could not be produced. */
  error: string | null;
}

/**
 * Collect the change set for a repository: committed work on this branch since
 * it diverged from the base, plus uncommitted and untracked changes.
 */
export function collectGitChangeSet(cwd: string, maxFiles: number): GitChangeSet | null {
  const repo = inspectRepo(cwd);
  if (!repo) return null;

  const statusEntries = parseStatus(runGit(repo.topLevel, ["status", "--porcelain"]).stdout)
    .filter((entry) => !shouldSkipPath(entry.path));

  let diffText = "";
  let baseDescription: string;
  let error: string | null = null;

  if (repo.baseRef) {
    const diff = runGit(repo.topLevel, ["diff", "--no-color", "-M", "-U3", repo.baseRef, "--"]);
    if (diff.ok) {
      diffText = diff.stdout;
      baseDescription = `working tree vs merge-base ${repo.baseRef.slice(0, 12)}`;
    } else {
      baseDescription = "working tree";
      error = `git diff against ${repo.baseRef} failed: ${diff.stderr.trim()}`;
    }
  } else {
    // No base branch: fall back to uncommitted work only, which is the common
    // case for an agent that has not committed anything.
    const diff = runGit(repo.topLevel, ["diff", "--no-color", "-M", "-U3", "HEAD", "--"]);
    diffText = diff.ok ? diff.stdout : "";
    baseDescription = "uncommitted changes vs HEAD";
    if (!diff.ok && repo.headSha) {
      error = `git diff HEAD failed: ${diff.stderr.trim()}`;
    }

    // A clean tree usually means the agent committed its work. With no base
    // branch to compare against, the most recent commit is the best evidence
    // available - and the verdict states that this is what it looked at, so the
    // basis of the review is never a secret.
    if (diffText.trim().length === 0 && statusEntries.length === 0 && repo.headSha) {
      const hasParent = runGit(repo.topLevel, ["rev-parse", "--verify", "--quiet", "HEAD~1"]).ok;
      if (hasParent) {
        const committed = runGit(repo.topLevel, ["diff", "--no-color", "-M", "-U3", "HEAD~1", "HEAD", "--"]);
        if (committed.ok && committed.stdout.trim().length > 0) {
          diffText = committed.stdout;
          baseDescription = "the most recent commit, because the working tree is clean";
        }
      }
    }
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

  return {
    repo,
    entries: [...diffs.keys()].map((path) => {
      const existing = statusEntries.find((entry) => entry.path === path);
      return existing ?? { path, status: diffs.get(path)?.status ?? "modified", oldPath: null };
    }).concat(limited),
    diffs,
    baseDescription,
    error,
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
