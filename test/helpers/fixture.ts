/**
 * Test fixtures.
 *
 * Fixtures are real git repositories created inside `.tmp-tests/` in the project
 * (which is gitignored) rather than in the system temp directory, so the tests
 * only ever write inside the project. Each fixture is removed by `dispose()`.
 *
 * The fixtures are deliberately *messy*: the whole point of the tool is to catch
 * the failure modes of real agent sessions, so the reviews are exercised against
 * partial implementations, hardcoded values, unhandled awaits, convention
 * mismatches and assertion-free tests rather than clean synthetic diffs.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TMP_ROOT = path.resolve(process.cwd(), ".tmp-tests");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export class TempRepo {
  readonly root: string;
  private disposed = false;

  constructor(prefix: string) {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    this.root = fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
    this.git(["init", "-b", "main"]);
    this.git(["config", "user.email", "test@example.com"]);
    this.git(["config", "user.name", "Test"]);
    this.git(["config", "commit.gpgsign", "false"]);
  }

  git(
    args: string[],
    env?: Record<string, string>,
  ): { status: number; stdout: string; stderr: string } {
    const result = spawnSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      env: env ? { ...GIT_ENV, ...env } : GIT_ENV,
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  write(relativePath: string, content: string): void {
    const absolute = path.join(this.root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  }

  read(relativePath: string): string {
    return fs.readFileSync(path.join(this.root, relativePath), "utf8");
  }

  remove(relativePath: string): void {
    fs.rmSync(path.join(this.root, relativePath), { recursive: true, force: true });
  }

  /** Stage everything and commit, so the change becomes part of the branch. */
  commit(message = "checkpoint"): void {
    this.git(["add", "-A"]);
    this.git(["-c", "commit.gpgsign=false", "commit", "-m", message, "--no-verify"]);
  }

  /**
   * Commit everything with an explicit committer date.
   *
   * The default fixture date is fixed, so tests that exercise the review scope's
   * age window have to set the clock themselves rather than rely on commit order
   * alone.
   */
  commitAt(isoDate: string, message = "checkpoint"): void {
    this.git(["add", "-A"]);
    this.git(["-c", "commit.gpgsign=false", "commit", "-m", message, "--no-verify"], {
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    });
  }

  /** Commit only the paths given, leaving the rest as working-tree changes. */
  commitPaths(paths: string[], message = "checkpoint"): void {
    this.git(["add", "--", ...paths]);
    this.git(["-c", "commit.gpgsign=false", "commit", "-m", message, "--no-verify"]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

export function disposeAll(repos: TempRepo[]): void {
  for (const repo of repos) repo.dispose();
}

/* ------------------------------------------------------------------ *
 * Shared fixture content
 * ------------------------------------------------------------------ */

export const PY_SNAKE_ORDERS = `"""Order handling."""

import json
from pathlib import Path

from .pricing import calculate_total


def load_order(order_path):
    """Read an order from disk."""
    try:
        with open(order_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as error:
        raise RuntimeError(f"could not read order from {order_path}") from error


def summarise_order(order):
    total = calculate_total(order["items"])
    lines = [f"{item['name']} x{item['quantity']}" for item in order["items"]]
    return {"order_id": order["id"], "lines": lines, "total": total}


def save_order(order, destination):
    destination = Path(destination)
    try:
        destination.write_text(json.dumps(order), encoding="utf-8")
    except OSError as error:
        raise RuntimeError(f"could not write order to {destination}") from error
    return destination
`;

export const PY_SNAKE_PRICING = `"""Pricing rules."""

TAX_RATE = 0.2
FREE_SHIPPING_THRESHOLD = 5000


def calculate_total(items):
    subtotal = sum(item["unit_price"] * item["quantity"] for item in items)
    total = subtotal * (1 + TAX_RATE)
    return round(total, 2)


def shipping_cost(total):
    if total >= FREE_SHIPPING_THRESHOLD:
        return 0
    return 499
`;

export const PY_SNAKE_TEST = `"""Tests for order handling."""

import pytest

from app.orders import summarise_order
from app.pricing import calculate_total, shipping_cost


def test_calculate_total_applies_tax():
    items = [{"unit_price": 1000, "quantity": 2}]
    assert calculate_total(items) == 2400.0


def test_shipping_is_free_above_threshold():
    assert shipping_cost(6000) == 0


def test_summarise_order_reports_lines_and_total():
    order = {"id": "A-1", "items": [{"name": "widget", "unit_price": 500, "quantity": 2}]}
    summary = summarise_order(order)
    assert summary["order_id"] == "A-1"
    assert summary["total"] == 1200.0
`;

/** A snake_case Python repository, used to prove convention detection. */
export function makeSnakeCasePythonRepo(): TempRepo {
  const repo = new TempRepo("py-snake");
  repo.write("app/__init__.py", "");
  repo.write("app/orders.py", PY_SNAKE_ORDERS);
  repo.write("app/pricing.py", PY_SNAKE_PRICING);
  repo.write("tests/test_orders.py", PY_SNAKE_TEST);
  repo.write("pyproject.toml", "[project]\nname = \"orders\"\nversion = \"0.1.0\"\n");
  repo.commit("initial commit");
  return repo;
}

/**
 * The messy change: camelCase in a snake_case repo, a hardcoded endpoint, a
 * marker left behind, an unhandled failure, and no test for any of it.
 */
export const PY_BAD_REPORT = `"""Report generation."""

import requests

REPORT_API = "https://reports.internal.example.com/v1/export"


def getUserData(userId):
    response = requests.get(f"{REPORT_API}/{userId}")
    payload = response.json()
    return payload["data"]


def formatReport(userData, includeTotals):
    rows = []
    for entry in userData["entries"]:
        rows.append(f"{entry['name']}: {entry['amount']}")
    if includeTotals:
        rows.append("TOTAL: " + str(sum(e["amount"] for e in userData["entries"])))
    return "\\n".join(rows)


def exportReport(userId, destination):
    # TODO: handle the case where the user has no entries yet
    data = getUserData(userId)
    with open(destination, "w", encoding="utf-8") as handle:
        handle.write(formatReport(data, True))
    return destination
`;

export const TS_CAMEL_API = `import { config } from "./config";

export interface User {
  id: string;
  name: string;
}

export async function fetchUser(id: string): Promise<User> {
  const response = await fetch(\`\${config.apiBaseUrl}/users/\${id}\`);
  if (!response.ok) {
    throw new Error(\`user request failed with \${response.status}\`);
  }
  return (await response.json()) as User;
}
`;

export const TS_CAMEL_CONFIG = `export const config = {
  apiBaseUrl: process.env.API_BASE_URL ?? "https://api.example.com",
  timeoutMs: 5_000,
};
`;

export const TS_CAMEL_TEST = `import { describe, expect, it } from "vitest";
import { fetchUser } from "./api";

describe("fetchUser", () => {
  it("returns the user payload", async () => {
    const user = await fetchUser("u-1");
    expect(user.id).toBeDefined();
  });
});
`;

export function makeCamelCaseTsRepo(): TempRepo {
  const repo = new TempRepo("ts-camel");
  repo.write("src/api.ts", TS_CAMEL_API);
  repo.write("src/config.ts", TS_CAMEL_CONFIG);
  repo.write("src/api.test.ts", TS_CAMEL_TEST);
  repo.write(
    "package.json",
    JSON.stringify({ name: "demo", version: "1.0.0", type: "module", devDependencies: { vitest: "^2.0.0" } }, null, 2),
  );
  repo.commit("initial commit");
  return repo;
}

/** camelCase functions in a camelCase repo: the convention checks should be quiet. */
export const TS_GOOD_NOTIFY = `import { config } from "./config";

export interface Notification {
  recipient: string;
  body: string;
}

export async function sendNotification(notification: Notification): Promise<void> {
  const response = await fetch(\`\${config.apiBaseUrl}/notifications\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(notification),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(\`could not send notification: \${response.status}\`);
  }
}
`;

export const TS_GOOD_NOTIFY_TEST = `import { describe, expect, it, vi } from "vitest";
import { sendNotification } from "./notify";

describe("sendNotification", () => {
  it("throws when the endpoint rejects the notification", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await expect(sendNotification({ recipient: "a", body: "b" })).rejects.toThrow(/could not send notification/);
  });
});
`;

/** A messy change in the TypeScript repo: no failure handling, hardcoded values, no tests. */
export const TS_BAD_NOTIFY = `import { config } from "./config";

interface WebhookPayload {
  event: string;
  data: unknown;
}

export async function deliverWebhook(payload: WebhookPayload) {
  const endpoint = "https://hooks.internal.example.com/ingest";
  const response = await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  console.log("webhook delivered", response.status);
  return response.status;
}

export function retryDelay(attempt: number): number {
  return attempt * 30000;
}
`;
