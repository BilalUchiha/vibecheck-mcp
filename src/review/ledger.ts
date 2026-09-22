/**
 * Review ledger.
 *
 * Two jobs:
 *
 *  1. Enforce the retry budget. Attempts are counted here rather than trusted
 *     from the agent's `attempt_number` argument, because a loop budget that the
 *     looping process controls is not a budget.
 *  2. Record enough for a human to answer "why did the agent loop, and what was
 *     still wrong at the end?".
 *
 * The log is append-only JSONL so that a crashed or concurrent run cannot
 * corrupt earlier entries, and so a user can read it with `grep`/`jq` without
 * this server. Resets are recorded as their own entries rather than by
 * rewriting history, which keeps the audit trail intact.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import type { Verdict } from "../types.js";

export const LOG_FILENAME = "reviews.jsonl";

export interface LoggedScore {
  score: number;
  threshold: number;
  passed: boolean;
}

export interface ReviewLogEntry {
  kind: "review" | "reset";
  ts: string;
  project: string;
  fingerprint: string;
  attempt?: number;
  verdict?: Verdict;
  scores?: Record<string, LoggedScore>;
  failed_dimensions?: string[];
  hard_gates?: string[];
  feedback_count?: number;
  task_preview?: string;
  evidence_source?: "git" | "submitted";
  changed_files?: string[];
  judge?: { provider: string; model: string; latency_ms: number; input_tokens?: number | null };
  config?: { preset: string; max_retries: number; config_path: string | null };
  warnings?: string[];
  note?: string;
}

/**
 * Identify a task so repeated submissions of the same work share a retry budget.
 *
 * The budget is deliberately keyed on the request wording alone. Keying it on the
 * changed file set as well would let the agent reset its own budget simply by
 * touching another file - and applying a fix very often does exactly that, by
 * adding the test file the review asked for. The unit of work is the request.
 */
export function taskFingerprint(taskDescription: string): string {
  const normalisedTask = taskDescription.trim().replace(/\s+/g, " ").toLowerCase();
  return crypto.createHash("sha256").update(normalisedTask).digest("hex").slice(0, 16);
}

export function logPath(stateDir: string): string {
  return path.join(stateDir, LOG_FILENAME);
}

export function appendEntry(stateDir: string, entry: ReviewLogEntry): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(logPath(stateDir), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    // Logging must never break a review. Report and continue.
    log.warn("could not append to the review log", { error: (error as Error).message });
  }
}

export function readEntries(stateDir: string): ReviewLogEntry[] {
  const file = logPath(stateDir);
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    log.warn("could not read the review log", { error: (error as Error).message });
    return [];
  }

  const entries: ReviewLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) entries.push(parsed as ReviewLogEntry);
    } catch {
      // A partially written final line is expected if a run was killed mid-write.
      log.debug("skipping unparseable review log line");
    }
  }
  return entries;
}

/**
 * Count submissions for a task since its last reset. A reset entry for the same
 * fingerprint clears that task; a reset with no fingerprint clears everything,
 * which is what `configure_project({ reset: true })` writes by default.
 */
/**
 * A submission only spends a retry if it actually produced a verdict. A judge
 * that was unreachable, or a malformed request, must not eat into the agent's
 * budget - otherwise a transient outage would escalate a reviewable change to
 * "max retries exceeded".
 */
function consumesAttempt(entry: ReviewLogEntry): boolean {
  return entry.verdict === "approved" || entry.verdict === "needs_fixes" || entry.verdict === "max_retries_exceeded";
}

export function countAttempts(stateDir: string, fingerprint: string): number {
  let count = 0;
  for (const entry of readEntries(stateDir)) {
    if (entry.kind === "reset") {
      if (!entry.fingerprint || entry.fingerprint === fingerprint) count = 0;
      continue;
    }
    if (entry.fingerprint === fingerprint && consumesAttempt(entry)) count++;
  }
  return count;
}

export function recordReset(stateDir: string, project: string, fingerprint: string | null): void {
  appendEntry(stateDir, {
    kind: "reset",
    ts: new Date().toISOString(),
    project,
    fingerprint: fingerprint ?? "",
    note: fingerprint ? "retry budget reset for this task" : "retry budgets reset for all tasks in this project",
  });
}

export interface LogQuery {
  limit?: number;
  fingerprint?: string;
  verdict?: Verdict;
}

export interface LogSummary {
  project: string;
  total_reviews: number;
  by_verdict: Record<string, number>;
  /** Dimensions that failed most often, most frequent first. */
  top_failing_dimensions: { dimension: string; count: number }[];
  /** Most recent first. */
  recent: ReviewLogEntry[];
  log_file: string;
}

export function summariseLog(stateDir: string, project: string, query: LogQuery = {}): LogSummary {
  const reviews = readEntries(stateDir).filter((entry) => entry.kind === "review");
  let filtered = reviews;
  if (query.fingerprint) filtered = filtered.filter((entry) => entry.fingerprint === query.fingerprint);
  if (query.verdict) filtered = filtered.filter((entry) => entry.verdict === query.verdict);

  const byVerdict: Record<string, number> = {};
  const dimensionCounts = new Map<string, number>();
  for (const entry of filtered) {
    const verdict = entry.verdict ?? "unknown";
    byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
    for (const dimension of entry.failed_dimensions ?? []) {
      dimensionCounts.set(dimension, (dimensionCounts.get(dimension) ?? 0) + 1);
    }
  }

  const topFailing = [...dimensionCounts.entries()]
    .map(([dimension, count]) => ({ dimension, count }))
    .sort((a, b) => b.count - a.count || a.dimension.localeCompare(b.dimension));

  const limit = Math.max(1, Math.min(query.limit ?? 10, 200));

  return {
    project,
    total_reviews: filtered.length,
    by_verdict: byVerdict,
    top_failing_dimensions: topFailing.slice(0, 12),
    recent: filtered.slice(-limit).reverse(),
    log_file: logPath(stateDir),
  };
}
