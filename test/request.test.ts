/**
 * Request verifiability tests.
 *
 * This check decides whether the gate judges a change at all, so both directions
 * matter and the cheaper mistake is asymmetric. Calling a clear request "too
 * vague" costs a round trip and asks the user to restate what they already said,
 * so the tests below pin a broad set of requests that must stay judgeable -
 * including ones that are only loosely specified - alongside the genuinely
 * open-ended ones that must not be scored.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessRequest } from "../src/context/request.js";

describe("request assessment", () => {
  describe("requests that cannot be verified", () => {
    const unverifiable: [string, string][] = [
      [
        "the request that motivated this check",
        "can you please work on this mcp more like i want it to be the best and using this mcp develpper get the best results possible so please make it better and better",
      ],
      ["a bare direction of travel", "make it better and better"],
      ["a quality adjective with no target", "improve error handling"],
      ["too short to state a requirement", "fix the bug"],
      ["a vague noun without a criterion", "polish the docs"],
    ];

    for (const [label, request] of unverifiable) {
      it(`flags ${label}`, () => {
        const assessment = assessRequest(request);
        assert.equal(assessment.verifiable, false, `"${request}" should not be judged`);
        assert.ok(assessment.signals.length > 0, "the reason must be stated");
        assert.ok(assessment.suggestions.length > 0, "the fix must be stated");
      });
    }

    it("names the judgement words it relied on", () => {
      const assessment = assessRequest("please improve and polish this so it is nicer");
      assert.ok(
        assessment.signals.some((signal) => /better|best|improve|polish|nicer/.test(signal)),
        "the agent should be told which words carried no requirement",
      );
    });

    it("says so when the acceptance criteria are vague too", () => {
      const assessment = assessRequest("make it better", "make it nicer and improve the quality");
      assert.equal(assessment.verifiable, false);
      assert.ok(
        assessment.signals.some((signal) => signal.includes("notes")),
        "the agent should know that adding criteria to `notes` did not settle it",
      );
    });
  });

  describe("requests that can be verified", () => {
    const verifiable: [string, string][] = [
      ["a file path", "Fix the swallowed-error detector in src/context/analyze.ts"],
      ["a backticked symbol", "Rename `getUserData` to `get_user_data` across the repo"],
      ["a command-line flag", "Add a --json flag to the inspect script"],
      ["a named artefact", "Poll the deploy endpoint until the build reports ready"],
      ["a stated outcome", "Add report export so a user can download their report as text"],
      ["a stated constraint", "When a user signs out, their session cookie should be cleared"],
      ["a measured quantity", "Reduce the default state budget from 60000 to 40000 characters"],
      ["a bare but checkable outcome", "Make the tests pass"],
      ["a plain description of the work", "Rename the report exporter and add a docstring"],
      ["an explicit constraint", "Add retry with backoff, without changing the public signature"],
    ];

    for (const [label, request] of verifiable) {
      it(`accepts ${label}`, () => {
        const assessment = assessRequest(request);
        assert.equal(
          assessment.verifiable,
          true,
          `"${request}" states something checkable and must be judged`,
        );
        assert.ok(assessment.signals.length > 0, "the reason must be stated");
        assert.deepEqual(assessment.suggestions, [], "a judgeable request needs no correction");
      });
    }

    it("accepts a vague request once acceptance criteria are supplied", () => {
      const assessment = assessRequest(
        "make it better",
        "Acceptance: `src/index.ts` must await the judge call, and test/loop.test.ts must pass.",
      );
      assert.equal(assessment.verifiable, true, "criteria in `notes` are what make a request judgeable");
    });

    it("accepts an empty-length guard: whitespace is not a requirement", () => {
      assert.equal(assessRequest("   please   ").verifiable, false);
    });
  });
});
