/**
 * Review-scope tests.
 *
 * The scope decides which commits a review covers, which is a correctness
 * question rather than a convenience one. When a task is committed in stages and
 * the review only sees the newest commit, the judge reasons about a fraction of
 * the work and reports a complete task as under-delivered - a confident verdict
 * about the wrong evidence, which is the failure this tool exists to prevent.
 *
 * These tests pin the rules that stop that, and the disclosure that makes the
 * chosen range visible in the verdict.
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { submitForReview } from "../src/review/orchestrator.js";
import { CONFIG_FILENAME } from "../src/config.js";
import { TempRepo, PY_SNAKE_PRICING } from "./helpers/fixture.js";

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

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

const TASK = "Add order export, wire it into the CLI, and keep the pricing helper intact.";

const EXPORT_PY = 'def export_orders(orders):\n    return "".join(order["id"] for order in orders)\n';
const WIRING_PY = 'from .export import export_orders\n\n\ndef wire(orders):\n    return export_orders(orders)\n';
const CLI_PY = 'from .wiring import wire\n\n\ndef main(orders):\n    return wire(orders)\n';
const LEGACY_PY = "def legacy_export(rows):\n    return len(rows)\n";

/**
 * A baseline commit, then one task committed in three steps, all inside the
 * default window. The baseline is dated by the fixture's fixed clock, so it can
 * never be mistaken for task work.
 */
function repoWithStagedTask(): TempRepo {
  const repo = new TempRepo("scope-staged");
  repo.write("app/pricing.py", PY_SNAKE_PRICING);
  repo.commit("baseline");
  repo.write("app/export.py", EXPORT_PY);
  repo.commitAt(hoursAgo(3), "step 1: exporter");
  repo.write("app/wiring.py", WIRING_PY);
  repo.commitAt(hoursAgo(2), "step 2: wiring");
  repo.write("app/cli.py", CLI_PY);
  repo.commitAt(hoursAgo(1), "step 3: cli");
  repos.push(repo);
  return repo;
}

/**
 * A baseline, then a first step committed long before the window and a second
 * step inside it. Only a claim can reach the first step.
 */
function repoWithOldFirstStep(): TempRepo {
  const repo = new TempRepo("scope-old-step");
  repo.write("app/pricing.py", PY_SNAKE_PRICING);
  repo.commit("baseline");
  repo.write("app/legacy.py", LEGACY_PY);
  repo.commitAt(hoursAgo(40), "step 1: legacy exporter");
  repo.write("app/cli.py", CLI_PY);
  repo.commitAt(hoursAgo(1), "step 2: cli");
  repos.push(repo);
  return repo;
}

describe("review scope", () => {
  it("reviews every commit of a staged task, not only the newest", async () => {
    const repo = repoWithStagedTask();
    const result = await submitForReview({ task_description: TASK, project_root: repo.root });

    assert.equal(result.evidence.scope?.rule, "recent-commits");
    assert.equal(result.evidence.scope?.commits, 3, "all three task commits must be in scope");
    for (const file of ["app/export.py", "app/wiring.py", "app/cli.py"]) {
      assert.ok(
        result.evidence.changed_files.includes(file),
        `${file} was part of the task and must be reviewed`,
      );
    }
    assert.ok(
      !result.evidence.changed_files.includes("app/pricing.py"),
      "the baseline commit predates the task and must not be reviewed as part of it",
    );
    assert.match(result.evidence.scope?.description ?? "", /commit\(s\)/);
  });

  it("widens the scope to cover a file reported from outside the window", async () => {
    const repo = repoWithOldFirstStep();

    const withoutClaim = await submitForReview({
      task_description: "Add the CLI entry point.",
      project_root: repo.root,
    });
    assert.equal(withoutClaim.evidence.scope?.rule, "recent-commits");
    assert.equal(withoutClaim.evidence.scope?.commits, 1);
    assert.ok(
      !withoutClaim.evidence.changed_files.includes("app/legacy.py"),
      "the 40h-old commit is outside the 12h window",
    );

    const withClaim = await submitForReview({
      task_description: "Add the exporter and the CLI entry point.",
      project_root: repo.root,
      changed_files: [{ path: "app/legacy.py" }, { path: "app/cli.py" }],
    });
    assert.equal(withClaim.evidence.scope?.rule, "claimed-commits");
    assert.equal(withClaim.evidence.scope?.commits, 2, "the claim pulls in the older commit");
    assert.ok(
      withClaim.evidence.changed_files.includes("app/legacy.py"),
      "a reported file widens the range, so the claim is judged on its diff",
    );
  });

  it("never presents an untouched repository as the change", async () => {
    const repo = new TempRepo("scope-single");
    repo.write("app/pricing.py", PY_SNAKE_PRICING);
    repo.commit("baseline");
    repos.push(repo);

    const result = await submitForReview({ task_description: TASK, project_root: repo.root });

    // A root commit has no "before" to diff against, so reviewing it would mean
    // presenting the whole repository as the change set.
    assert.equal(result.evidence.scope?.rule, "none");
    assert.deepEqual(result.evidence.changed_files, []);
  });

  it("still fails a file git has no record of changing", async () => {
    const repo = repoWithStagedTask();
    const result = await submitForReview({
      task_description: "Add the exporter and the CLI entry point.",
      project_root: repo.root,
      changed_files: [{ path: "app/ghost.py" }],
    });

    assert.ok(
      result.hard_gate_failures.some((failure) => failure.gate === "submission_mismatch"),
      "a claim git cannot place at all is a hard failure, not a scope note",
    );
  });

  it("reports a claim it cannot reach instead of failing or dropping it", async () => {
    const repo = repoWithOldFirstStep();
    // A one-commit scope cannot reach the 40h-old commit, even though the agent
    // reported the file it produced.
    repo.write(CONFIG_FILENAME, `${JSON.stringify({ scope: { maxCommits: 1 } }, null, 2)}\n`);

    const result = await submitForReview({
      task_description: "Add the exporter and the CLI entry point.",
      project_root: repo.root,
      changed_files: [{ path: "app/legacy.py" }, { path: "app/cli.py" }],
    });

    assert.deepEqual(result.evidence.scope?.unreached_claims, ["app/legacy.py"]);
    assert.ok(
      result.warnings.some((warning) => warning.includes("app/legacy.py") && warning.includes("outside the reviewed range")),
      "the agent must be told the file it reported was not judged",
    );
    assert.ok(
      !result.hard_gate_failures.some((failure) => failure.gate === "submission_mismatch"),
      "git can place the file, so this is a scope problem and not a false claim",
    );
  });

  it("honours an explicit last-commit scope", async () => {
    const repo = repoWithStagedTask();
    repo.write(CONFIG_FILENAME, `${JSON.stringify({ scope: { mode: "last-commit" } }, null, 2)}\n`);

    const result = await submitForReview({ task_description: TASK, project_root: repo.root });

    assert.equal(result.evidence.scope?.rule, "last-commit");
    assert.equal(result.evidence.scope?.commits, 1);
    assert.ok(result.evidence.changed_files.includes("app/cli.py"));
    assert.ok(!result.evidence.changed_files.includes("app/export.py"));
  });
});
