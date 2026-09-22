#!/usr/bin/env node
/**
 * Manual review inspector.
 *
 * The most useful thing this script does is let you read a verdict the way the
 * agent will read it, so you can tune thresholds against real repositories
 * rather than guessing. It is also the fastest way to check the feedback layer
 * is producing specific instructions instead of generic advice.
 *
 * Usage:
 *   npx tsx scripts/inspect.ts --demo python
 *   npx tsx scripts/inspect.ts --demo ts --task "Add webhook delivery"
 *   npx tsx scripts/inspect.ts --root /path/to/repo --task "..." [--json]
 *   npx tsx scripts/inspect.ts --demo python --fix   # apply the fixes and review again
 *
 * With `--fix`, the demo fixtures are repaired in place and re-reviewed, which
 * shows the loop closing: the same task moves from needs_fixes to approved.
 */

import fs from "node:fs";
import path from "node:path";
import { loadDotEnvFiles } from "../src/env.js";
import { renderVerdictText, submitForReview } from "../src/review/orchestrator.js";
import {
  makeCamelCaseTsRepo,
  makeSnakeCasePythonRepo,
  PY_BAD_REPORT,
  TS_BAD_NOTIFY,
  type TempRepo,
} from "../test/helpers/fixture.js";

const PY_FIXED_REPORT = `"""Report generation."""

import os

import requests


def _report_endpoint():
    """The report service base URL, configured per environment."""
    base = os.environ.get("REPORT_API_BASE_URL")
    if not base:
        raise RuntimeError("REPORT_API_BASE_URL is not set")
    return base


def get_user_data(user_id):
    """Fetch the report payload for a single user."""
    timeout_seconds = float(os.environ.get("REPORT_API_TIMEOUT_SECONDS", "5"))
    try:
        response = requests.get(f"{_report_endpoint()}/users/{user_id}", timeout=timeout_seconds)
        response.raise_for_status()
    except requests.RequestException as error:
        raise RuntimeError(f"could not load report for {user_id}") from error

    try:
        return response.json()["data"]
    except (ValueError, KeyError) as error:
        raise RuntimeError(f"report payload for {user_id} was not in the expected shape") from error


def format_report(user_data, include_totals):
    entries = user_data.get("entries") or []
    if not entries:
        return "No entries to report."

    rows = [f"{entry['name']}: {entry['amount']}" for entry in entries]
    if include_totals:
        rows.append(f"TOTAL: {sum(entry['amount'] for entry in entries)}")
    return "\\n".join(rows)


def export_report(user_id, destination):
    """Write a user's report to disk."""
    payload = get_user_data(user_id)
    text = format_report(payload, include_totals=True)
    try:
        with open(destination, "w", encoding="utf-8") as handle:
            handle.write(text)
    except OSError as error:
        raise RuntimeError(f"could not write report to {destination}") from error
    return destination
`;

const PY_FIXED_TEST = `"""Tests for report export."""

import pytest

from app.reports import export_report, format_report, get_user_data


def test_format_report_includes_a_total_when_asked():
    payload = {"entries": [{"name": "widget", "amount": 5}, {"name": "gadget", "amount": 7}]}
    assert format_report(payload, include_totals=True).splitlines()[-1] == "TOTAL: 12"


def test_format_report_explains_an_empty_report():
    assert format_report({"entries": []}, include_totals=True) == "No entries to report."


def test_get_user_data_raises_when_the_endpoint_fails(monkeypatch):
    class Failing:
        def get(self, *args, **kwargs):
            raise requests.RequestException("boom")

    monkeypatch.setenv("REPORT_API_BASE_URL", "https://reports.example.com")
    monkeypatch.setattr("app.reports.requests", Failing())
    with pytest.raises(RuntimeError, match="could not load report"):
        get_user_data("u-1")
`;

const TS_FIXED_NOTIFY = `import { config } from "./config";

interface WebhookPayload {
  event: string;
  data: unknown;
}

export async function deliverWebhook(payload: WebhookPayload): Promise<number> {
  const endpoint = config.webhookEndpoint;
  if (!endpoint) {
    throw new Error("webhookEndpoint is not configured");
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new Error(\`could not reach the webhook endpoint: \${String(error)}\`);
  }

  if (!response.ok) {
    throw new Error(\`webhook endpoint rejected the payload: \${response.status}\`);
  }
  return response.status;
}

/** Exponential backoff with a ceiling, so retries stay bounded. */
export function retryDelay(attempt: number): number {
  const baseDelayMs = 500;
  const maxDelayMs = 30_000;
  return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
}
`;

const TS_FIXED_NOTIFY_TEST = `import { describe, expect, it, vi } from "vitest";
import { deliverWebhook, retryDelay } from "./notify";

describe("deliverWebhook", () => {
  it("throws when the endpoint rejects the payload", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await expect(deliverWebhook({ event: "x", data: {} })).rejects.toThrow(/rejected the payload/);
  });

  it("never exceeds the retry ceiling", () => {
    expect(retryDelay(20)).toBeLessThanOrEqual(30_000);
  });
});
`;

interface Options {
  root?: string;
  task?: string;
  demo?: "python" | "ts";
  json: boolean;
  fix: boolean;
  provider: "mock" | "typesafe";
}

function parseArgs(argv: string[]): Options {
  const options: Options = { json: false, fix: false, provider: "mock" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--root") options.root = argv[++index];
    else if (arg === "--task") options.task = argv[++index];
    else if (arg === "--demo") options.demo = argv[++index] as Options["demo"];
    else if (arg === "--provider") options.provider = argv[++index] as Options["provider"];
    else if (arg === "--json") options.json = true;
    else if (arg === "--fix") options.fix = true;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  return options;
}

function printUsage(): void {
  console.log(`vibe-check review inspector

  --demo <python|ts>   create a messy fixture repository and review it
  --root <path>        review an existing repository
  --task "<request>"   the user's original request
  --fix                repair the demo fixture and review again
  --provider <p>       mock (default, offline) or typesafe (needs TYPESAFE_API_KEY)
  --json               print the raw result instead of the rendered verdict
`);
}

async function main(): Promise<void> {
  // Same `.env` the server reads, so `--provider typesafe` picks up the key the
  // user already configured rather than demanding it on the command line.
  const dotenv = loadDotEnvFiles();
  if (dotenv.keys.length > 0) {
    console.error(`loaded .env from ${dotenv.loaded.join(", ")} (${dotenv.keys.join(", ")})`);
  }

  const options = parseArgs(process.argv.slice(2));
  process.env.VIBECHECK_JUDGE = options.provider;

  let repo: TempRepo | null = null;
  let task = options.task;
  let root = options.root;

  if (options.demo) {
    if (options.demo === "python") {
      repo = makeSnakeCasePythonRepo();
      repo.write("app/reports.py", PY_BAD_REPORT);
      task ??= "Add report export so a user can download their report as text.";
      root = repo.root;
    } else {
      repo = makeCamelCaseTsRepo();
      repo.write("src/notify.ts", TS_BAD_NOTIFY);
      task ??= "Add webhook delivery for notifications.";
      root = repo.root;
    }
  }

  if (!root) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  task ??= "Implement the requested change.";

  try {
    if (options.fix) {
      if (!options.demo) {
        console.error("--fix only applies to --demo fixtures.");
        process.exitCode = 1;
        return;
      }
      // Review the messy state first, then repair it and review again. The
      // attempt counter advances across both, which is the real behaviour.
      const before = await submitForReview({ task_description: task, project_root: root });
      console.log("=== pass 1: the change as submitted ===\n");
      console.log(options.json ? JSON.stringify(before, null, 2) : renderVerdictText(before));

      applyFixes(options.demo, repo, root);

      const after = await submitForReview({
        task_description: task,
        project_root: root,
        notes: "The issues reported in the previous review have been addressed.",
      });
      console.log("\n=== pass 2: after applying the fixes ===\n");
      console.log(options.json ? JSON.stringify(after, null, 2) : renderVerdictText(after));
      console.log(`\nverdict moved: ${before.verdict} -> ${after.verdict}`);
    } else {
      const result = await submitForReview({ task_description: task, project_root: root });
      console.log(options.json ? JSON.stringify(result, null, 2) : renderVerdictText(result));
    }
  } finally {
    if (options.json && repo) {
      // Leave demo fixtures on disk for inspection when JSON output was asked for.
      console.log(`\n(fixture kept for inspection at ${repo.root})`);
    } else {
      repo?.dispose();
    }
  }
}

function applyFixes(demo: "python" | "ts", repo: TempRepo | null, root: string): void {
  const write = (relative: string, content: string): void => {
    if (repo) repo.write(relative, content);
    else fs.writeFileSync(path.join(root, relative), content, "utf8");
  };
  if (demo === "python") {
    write("app/reports.py", PY_FIXED_REPORT);
    write("tests/test_reports.py", PY_FIXED_TEST);
  } else {
    write("src/notify.ts", TS_FIXED_NOTIFY);
    write("src/notify.test.ts", TS_FIXED_NOTIFY_TEST);
  }
  console.log("applied fixes\n");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
