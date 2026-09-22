/**
 * End-to-end loop tests.
 *
 * These exercise the behaviour the tool is bought for: that a failing review
 * turns into a specific fix list, that fixing the list clears the review, that
 * the retry budget is enforced by the server rather than the agent, and that
 * escalation tells the agent to stop rather than loop forever.
 *
 * The offline judge is used throughout, because these tests are about the
 * plumbing and the policy around the judge, not about the judge's judgment.
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { submitForReview } from "../src/review/orchestrator.js";
import { recordReset } from "../src/review/ledger.js";
import { CONFIG_FILENAME } from "../src/config.js";
import {
  makeSnakeCasePythonRepo,
  PY_BAD_REPORT,
  type TempRepo,
} from "./helpers/fixture.js";

const repos: TempRepo[] = [];

after(() => {
  for (const repo of repos) repo.dispose();
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
  process.env.VIBECHECK_JUDGE = "mock";
  process.env.VIBECHECK_LOG_LEVEL = "silent";
});

beforeEach(() => {
  process.env.VIBECHECK_JUDGE = "mock";
  process.env.VIBECHECK_LOG_LEVEL = "silent";
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
});

/** A snake_case repo carrying the messy camelCase report file. */
function repoWithBadChange(): TempRepo {
  const repo = makeSnakeCasePythonRepo();
  repo.write("app/reports.py", PY_BAD_REPORT);
  repos.push(repo);
  return repo;
}

function repoWithGoodChange(): TempRepo {
  const repo = makeSnakeCasePythonRepo();
  repo.write(
    "app/reports.py",
    [
      '"""Report export."""',
      "",
      "import os",
      "",
      "import requests",
      "",
      "",
      "def report_endpoint():",
      '    base = os.environ.get("REPORT_API_BASE_URL")',
      "    if not base:",
      '        raise RuntimeError("REPORT_API_BASE_URL is not set")',
      "    return base",
      "",
      "",
      "def get_user_data(user_id):",
      "    try:",
      '        response = requests.get(f"{report_endpoint()}/users/{user_id}")',
      "        response.raise_for_status()",
      "    except requests.RequestException as error:",
      '        raise RuntimeError("could not load the report") from error',
      '    return response.json()["data"]',
      "",
      "",
      "def format_report(user_data):",
      '    entries = user_data.get("entries") or []',
      '    return "\\n".join(f"{entry[\'name\']}: {entry[\'amount\']}" for entry in entries)',
    ].join("\n"),
  );
  repo.write(
    "tests/test_reports.py",
    [
      '"""Tests for report export."""',
      "",
      "import pytest",
      "",
      "from app.reports import format_report, get_user_data",
      "",
      "",
      "def test_format_report_explains_an_empty_report():",
      '    assert format_report({"entries": []}) == ""',
      "",
      "",
      "def test_get_user_data_raises_when_the_endpoint_fails(monkeypatch):",
      "    class Failing:",
      "        def get(self, *args, **kwargs):",
      '            raise RuntimeError("boom")',
      "",
      '    monkeypatch.setenv("REPORT_API_BASE_URL", "https://reports.example.com")',
      '    monkeypatch.setattr("app.reports.requests", Failing())',
      "    with pytest.raises(RuntimeError):",
      '        get_user_data("u-1")',
    ].join("\n"),
  );
  repos.push(repo);
  return repo;
}

const TASK = "Add report export so a user can download their report as text.";

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

describe("evidence collection", () => {
  it("reviews git's view of the repository even when the agent submits nothing", async () => {
    const repo = repoWithBadChange();
    const result = await submitForReview({ task_description: TASK, project_root: repo.root });

    assert.equal(result.evidence.source, "git");
    assert.ok(
      result.evidence.changed_files.includes("app/reports.py"),
      "the untracked file must be discovered by the server, not reported by the agent",
    );
  });

  it("includes committed work on the branch, not only uncommitted edits", async () => {
    const repo = repoWithBadChange();
    repo.commit("agent committed its work");
    const result = await submitForReview({ task_description: TASK, project_root: repo.root });
    assert.ok(result.evidence.changed_files.includes("app/reports.py"));
  });

  it("ignores the agent's own attempt_number", async () => {
    const repo = repoWithBadChange();
    const result = await submitForReview({
      task_description: TASK,
      project_root: repo.root,
      attempt_number: 99,
    });
    assert.equal(result.attempt_number, 1, "the server counts attempts, not the agent");
  });
});

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

describe("the review loop", () => {
  it("rejects the messy change with specific fixes", async () => {
    const repo = repoWithBadChange();
    const result = await submitForReview({ task_description: TASK, project_root: repo.root });

    assert.equal(result.verdict, "needs_fixes");
    assert.equal(result.review_performed, true);
    assert.ok(result.feedback.length > 0, "a failing review must produce fixes");
    assert.equal(result.attempts_remaining, result.max_retries - 1);

    for (const item of result.feedback) {
      assert.ok(item.instruction.length > 30, `${item.dimension} needs a real instruction`);
      assert.ok(item.evidence.length > 0, `${item.dimension} needs evidence`);
    }

    const conventions = result.feedback.find((item) => item.dimension === "follows_conventions");
    assert.ok(conventions, "the camelCase-in-a-snake-case-repo divergence must be caught");
    assert.match(conventions.evidence.join("\n"), /snake_case/);
  });

  it("approves the same task once the fixes are applied, and counts the attempt", async () => {
    const repo = repoWithBadChange();
    const first = await submitForReview({ task_description: TASK, project_root: repo.root });
    assert.equal(first.verdict, "needs_fixes");

    // Apply the reported fixes: snake_case, configuration instead of a literal,
    // failure handling, and a test that asserts on behaviour.
    repo.write(
      "app/reports.py",
      [
        '"""Report export."""',
        "",
        "import os",
        "",
        "import requests",
        "",
        "",
        "def report_endpoint():",
        '    base = os.environ.get("REPORT_API_BASE_URL")',
        "    if not base:",
        '        raise RuntimeError("REPORT_API_BASE_URL is not set")',
        "    return base",
        "",
        "",
        "def get_user_data(user_id):",
        "    try:",
        '        response = requests.get(f"{report_endpoint()}/users/{user_id}")',
        "        response.raise_for_status()",
        "    except requests.RequestException as error:",
        '        raise RuntimeError("could not load the report") from error',
        '    return response.json()["data"]',
        "",
        "",
        "def format_report(user_data):",
        '    entries = user_data.get("entries") or []',
        '    return "\\n".join(f"{entry[\'name\']}: {entry[\'amount\']}" for entry in entries)',
      ].join("\n"),
    );
    repo.write(
      "tests/test_reports.py",
      [
        "import pytest",
        "",
        "from app.reports import format_report",
        "",
        "",
        "def test_format_report_is_empty_for_no_entries():",
        '    assert format_report({"entries": []}) == ""',
        "",
        "",
        "def test_format_report_lists_entries():",
        '    payload = {"entries": [{"name": "widget", "amount": 5}]}',
        '    assert format_report(payload) == "widget: 5"',
      ].join("\n"),
    );

    const second = await submitForReview({ task_description: TASK, project_root: repo.root });
    assert.equal(second.attempt_number, 2, "adding a test file must not reset the retry budget");
    assert.equal(second.verdict, "approved", `expected approval, got: ${JSON.stringify(second.scores)}`);
    assert.equal(second.feedback.length, 0, "an approval carries no fixes");
    assert.match(second.next_action, /Report completion/);
  });

  it("escalates instead of looping forever when the budget is exhausted", async () => {
    const repo = repoWithBadChange();
    repo.write(CONFIG_FILENAME, JSON.stringify({ maxRetries: 1, preset: "strict" }));

    const result = await submitForReview({ task_description: TASK, project_root: repo.root });

    assert.equal(result.verdict, "max_retries_exceeded");
    assert.equal(result.attempts_remaining, 0);
    assert.match(result.next_action, /not verified as complete|NOT verified/i);
    assert.match(result.next_action, /report to the user/i);
    assert.ok(result.feedback.length > 0, "the outstanding issues must still be listed");
  });

  it("treats a changed task description as a new task with a fresh budget", async () => {
    const repo = repoWithBadChange();
    repo.write(CONFIG_FILENAME, JSON.stringify({ maxRetries: 2 }));

    const first = await submitForReview({ task_description: TASK, project_root: repo.root });
    assert.equal(first.verdict, "needs_fixes");

    const different = await submitForReview({
      task_description: "Rename the report exporter and add a docstring.",
      project_root: repo.root,
    });
    assert.equal(different.attempt_number, 1, "a different request starts its own budget");
  });

  it("clears the budget on request", async () => {
    const repo = repoWithBadChange();
    repo.write(CONFIG_FILENAME, JSON.stringify({ maxRetries: 2 }));

    const first = await submitForReview({ task_description: TASK, project_root: repo.root });
    assert.equal(first.verdict, "needs_fixes");
    const exhausted = await submitForReview({ task_description: TASK, project_root: repo.root });
    assert.equal(exhausted.verdict, "max_retries_exceeded");

    recordReset(`${repo.root}/.vibecheck`, repo.root, null);

    const afterReset = await submitForReview({ task_description: TASK, project_root: repo.root });
    assert.equal(afterReset.attempt_number, 1, "the reset restores the budget");
    assert.equal(afterReset.verdict, "needs_fixes", "back to reviewing rather than escalating");
    assert.equal(afterReset.attempts_remaining, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Hard gates
 * ------------------------------------------------------------------ */

describe("hard gates", () => {
  it("fails the review when a claimed file was never changed", async () => {
    const repo = repoWithBadChange();
    const result = await submitForReview({
      task_description: TASK,
      project_root: repo.root,
      changed_files: [{ path: "app/ghost.py", content: "def getThing():\n    return 1\n" }],
    });

    assert.equal(result.verdict, "needs_fixes");
    const gate = result.hard_gate_failures.find((failure) => failure.gate === "submission_mismatch");
    assert.ok(gate, "a fabricated change set must be reported");
    assert.ok(gate.evidence.some((line) => line.includes("app/ghost.py")));
    assert.equal(result.feedback[0]?.dimension, "hard_gate:submission_mismatch", "facts come first");
  });

  it("fails the review when the supplied tests are red", async () => {
    const repo = repoWithGoodChange();
    const result = await submitForReview({
      task_description: TASK,
      project_root: repo.root,
      test_results: "Tests: 2 failed, 5 passed, 7 total",
    });

    const gate = result.hard_gate_failures.find((failure) => failure.gate === "failing_tests");
    assert.ok(gate, "red tests are a fact, not a judgment");
    assert.equal(result.verdict, "needs_fixes");
  });

  it("fails the review when a credential is added, and never echoes it", async () => {
    const repo = makeSnakeCasePythonRepo();
    repos.push(repo);
    const secret = "sk-live-9f8a7b6c5d4e3f2a1b0c";
    repo.write("app/settings.py", `API_KEY = "${secret}"\n`);

    const result = await submitForReview({ task_description: TASK, project_root: repo.root });

    const gate = result.hard_gate_failures.find((failure) => failure.gate === "committed_secret");
    assert.ok(gate, "a credential in the diff must gate the review");
    assert.ok(!JSON.stringify(result).includes(secret), "the raw credential must never appear in the result");
  });

  it("accepts a passing test run", async () => {
    const repo = repoWithGoodChange();
    const result = await submitForReview({
      task_description: TASK,
      project_root: repo.root,
      test_results: { passed: true, failures: 0, output: "5 passed in 0.4s" },
    });
    assert.equal(result.hard_gate_failures.length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Judge failure handling
 * ------------------------------------------------------------------ */

describe("judge failures", () => {
  it("reports an unavailable judge without spending a retry, and does not claim approval", async () => {
    const repo = repoWithBadChange();
    repo.write(
      CONFIG_FILENAME,
      JSON.stringify({ judge: { provider: "typesafe", maxAttempts: 1, timeoutMs: 2000 } }),
    );

    delete process.env.VIBECHECK_JUDGE;
    process.env.TYPESAFE_API_KEY = "test-key-not-real";
    // A discard port: the connection is refused immediately, so the test stays fast.
    process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:9";

    try {
      const failed = await submitForReview({ task_description: TASK, project_root: repo.root });

      assert.equal(failed.verdict, "review_unavailable");
      assert.equal(failed.review_performed, false);
      assert.equal(failed.approved, false, "an unreviewed change must never be reported as approved");
      assert.ok(failed.judge_error, "the failure must be explained");
      assert.match(failed.next_action, /not judged|neither passed nor failed|not been verified/i);

      // The failed attempt must not count against the budget.
      process.env.VIBECHECK_JUDGE = "mock";
      delete process.env.TYPESAFE_BASE_URL;
      const retried = await submitForReview({ task_description: TASK, project_root: repo.root });
      assert.equal(retried.attempt_number, 1, "a broken judge must not consume the agent's retries");
      assert.equal(retried.review_performed, true);
    } finally {
      delete process.env.TYPESAFE_API_KEY;
      delete process.env.TYPESAFE_BASE_URL;
      process.env.VIBECHECK_JUDGE = "mock";
    }
  });
});

/* ------------------------------------------------------------------ *
 * Budget limits
 * ------------------------------------------------------------------ */

describe("state budget", () => {
  it("stays inside the configured budget for a very large change, and says what it left out", async () => {
    const repo = makeSnakeCasePythonRepo();
    repos.push(repo);
    const huge = ["import os", ""].concat(
      Array.from({ length: 20_000 }, (_, index) => `def handler_${index}(value_${index}):\n    return value_${index}`),
    );
    repo.write("app/huge.py", `${huge.join("\n")}\n`);
    repo.write(CONFIG_FILENAME, JSON.stringify({ budget: { maxStateChars: 8_000, maxCharsPerFile: 1_000 } }));

    const result = await submitForReview({ task_description: TASK, project_root: repo.root });

    assert.equal(result.review_performed, true, "a large change must still be reviewable");
    assert.ok(
      result.warnings.some((warning) => /truncated|omitted/i.test(warning)),
      `expected a truncation warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });
});
