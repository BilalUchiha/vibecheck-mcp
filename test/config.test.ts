import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  CONFIG_FILENAME,
  MAX_RETRIES_LIMIT,
  defaultConfig,
  loadConfig,
  mergeConfig,
  saveConfig,
} from "../src/config.js";
import { makeSnakeCasePythonRepo, type TempRepo } from "./helpers/fixture.js";

const repos: TempRepo[] = [];
after(() => {
  for (const repo of repos) repo.dispose();
});

function tempRepo(): TempRepo {
  const repo = makeSnakeCasePythonRepo();
  repos.push(repo);
  return repo;
}

describe("presets", () => {
  it("orders the presets by strictness on every dimension", () => {
    const lenient = defaultConfig("lenient");
    const balanced = defaultConfig("balanced");
    const strict = defaultConfig("strict");
    for (const dimension of Object.keys(balanced.questions) as (keyof typeof balanced.questions)[]) {
      assert.ok(
        lenient.questions[dimension].threshold <= balanced.questions[dimension].threshold,
        `${dimension}: lenient should not be stricter than balanced`,
      );
      assert.ok(
        balanced.questions[dimension].threshold <= strict.questions[dimension].threshold,
        `${dimension}: balanced should not be stricter than strict`,
      );
    }
  });

  it("keeps every threshold inside 0-1 and every weight positive", () => {
    for (const preset of ["lenient", "balanced", "strict"] as const) {
      const config = defaultConfig(preset);
      for (const question of Object.values(config.questions)) {
        assert.ok(question.threshold >= 0 && question.threshold <= 1, `${preset} threshold in range`);
        assert.ok(question.weight > 0, `${preset} weight positive`);
      }
    }
  });

  it("defaults to auto provider selection so a key is used when present", () => {
    assert.equal(defaultConfig().judge.provider, "auto");
  });

  it("gives a request a roomy retry budget, independent of the preset", () => {
    // The budget is about convergence, not strictness: a strict project should
    // not get fewer chances to fix what the gate found, and a budget that expires
    // while the fix list is still shrinking escalates a fixable change.
    assert.equal(defaultConfig("lenient").maxRetries, 10);
    assert.equal(defaultConfig("balanced").maxRetries, 10);
    assert.equal(defaultConfig("strict").maxRetries, 10);
  });

  it("clamps an oversized retry budget to the declared limit", () => {
    const { config } = mergeConfig(defaultConfig(), { maxRetries: 999 });
    assert.equal(config.maxRetries, MAX_RETRIES_LIMIT);
  });

  it("defaults to reviewing the task's own commits rather than a single commit", () => {
    const scope = defaultConfig().scope;
    assert.equal(scope.mode, "auto");
    assert.ok(scope.maxCommits > 1, "a staged task needs more than one commit in scope");
    assert.ok(scope.maxAgeHours > 0);
  });
});

describe("merging", () => {
  it("ignores `//` comment keys instead of warning at them", () => {
    const { errors } = mergeConfig(defaultConfig(), {
      questions: { "//": "an annotated example config", readability: { threshold: 0.5 } } as never,
    });
    assert.deepEqual(errors, [], "comment keys are a convention, not a mistake");
  });

  it("merges scope settings and rejects an unknown mode", () => {
    const merged = mergeConfig(defaultConfig(), {
      scope: { mode: "working-tree", maxAgeHours: 6, maxCommits: 5 },
    });
    assert.equal(merged.config.scope.mode, "working-tree");
    assert.equal(merged.config.scope.maxAgeHours, 6);
    assert.equal(merged.config.scope.maxCommits, 5);
    assert.deepEqual(merged.errors, []);

    const invalid = mergeConfig(defaultConfig(), { scope: { mode: "everything" as never } });
    assert.equal(invalid.config.scope.mode, "auto", "an invalid mode leaves the default in place");
    assert.ok(invalid.errors.some((error) => error.includes("scope.mode")));
  });

  it("applies a preset as a new baseline, then the overrides on top", () => {
    const base = defaultConfig("balanced");
    const { config } = mergeConfig(base, {
      preset: "strict",
      questions: { readability: { threshold: 0.5 } },
    });
    assert.equal(config.preset, "strict");
    assert.equal(config.questions.readability.threshold, 0.5, "explicit override wins");
    assert.equal(
      config.questions.satisfies_request.threshold,
      defaultConfig("strict").questions.satisfies_request.threshold,
      "unmentioned dimensions take the preset value",
    );
  });

  it("rejects out-of-range values instead of silently clamping them", () => {
    const { config, errors } = mergeConfig(defaultConfig(), {
      questions: { readability: { threshold: 4 } },
      maxRetries: 0,
    });
    assert.ok(errors.some((error) => error.includes("threshold")));
    assert.ok(errors.some((error) => error.includes("maxRetries")));
    assert.equal(config.questions.readability.threshold, defaultConfig().questions.readability.threshold);
  });

  it("rejects unknown dimension names so a typo cannot silently do nothing", () => {
    const { errors } = mergeConfig(defaultConfig(), {
      questions: { satisfies_requests: { threshold: 0.5 } } as never,
    });
    assert.ok(errors.some((error) => error.includes("unknown question id")));
  });

  it("never takes credentials from the config file", () => {
    const { config } = mergeConfig(defaultConfig(), {
      judge: { model: "jev-1.13.0" },
    });
    assert.equal(config.judge.model, "jev-1.13.0");
    assert.ok(!("apiKey" in config.judge), "the config has no field for a key");
  });
});

describe("loading and saving", () => {
  it("falls back to defaults when there is no config file", () => {
    const repo = tempRepo();
    const resolved = loadConfig(repo.root);
    assert.equal(resolved.configPath, null);
    assert.equal(resolved.config.preset, "balanced");
    assert.equal(resolved.stateDir, path.join(repo.root, ".vibecheck"));
  });

  it("warns about a corrupt config instead of failing the review", () => {
    const repo = tempRepo();
    repo.write(CONFIG_FILENAME, "{ this is not json");
    const resolved = loadConfig(repo.root);
    assert.ok(resolved.warnings.some((warning) => warning.includes("not valid JSON")));
    assert.equal(resolved.config.preset, "balanced");
  });

  it("round-trips a saved config", () => {
    const repo = tempRepo();
    saveConfig(repo.root, {
      preset: "strict",
      maxRetries: 5,
      questions: { readability: { threshold: 0.8, enabled: false } },
      conventions: { mode: "file", styleGuide: "STYLE.md" },
    });
    const resolved = loadConfig(repo.root);
    assert.equal(resolved.config.preset, "strict");
    assert.equal(resolved.config.maxRetries, 5);
    assert.equal(resolved.config.questions.readability.threshold, 0.8);
    assert.equal(resolved.config.questions.readability.enabled, false);
    assert.equal(resolved.config.conventions.mode, "file");
    assert.equal(resolved.config.conventions.styleGuide, "STYLE.md");
    assert.ok(resolved.configPath?.endsWith(CONFIG_FILENAME));
  });

  it("merges a second save into the existing file instead of replacing it", () => {
    const repo = tempRepo();
    saveConfig(repo.root, { preset: "strict" });
    saveConfig(repo.root, { questions: { readability: { threshold: 0.9 } } });
    const raw = JSON.parse(fs.readFileSync(path.join(repo.root, CONFIG_FILENAME), "utf8")) as Record<string, unknown>;
    assert.equal(raw.preset, "strict", "the earlier setting survives");
    assert.ok(raw.questions, "the new setting was added");
  });

  it("lets tool arguments override the file", () => {
    const repo = tempRepo();
    repo.write(CONFIG_FILENAME, JSON.stringify({ maxRetries: 2 }));
    const resolved = loadConfig(repo.root, { maxRetries: 7 });
    assert.equal(resolved.config.maxRetries, 7);
  });
});
