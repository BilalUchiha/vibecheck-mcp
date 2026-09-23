/**
 * Feedback translation tests.
 *
 * These assert the thing the tool is actually for: that a low score comes back
 * as a specific instruction naming a file, a symbol and a change to make - not
 * as a restatement of the score. They also assert the inverse, that no
 * instruction is emitted without measured evidence behind it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyseChanges, mergeProfiles, profileSource } from "../src/context/analyze.js";
import { defaultConfig } from "../src/config.js";
import { buildFeedback, splitWords, toStyle } from "../src/review/feedback.js";
import type { AnalysisReport, ChangedFile, DimensionScore, FeedbackItem } from "../src/types.js";
import type { ConventionReference } from "../src/context/conventions.js";

function changed(path: string, content: string, diff?: string): ChangedFile {
  return {
    path,
    status: "added",
    content,
    diff,
    added: content.split("\n").length,
    removed: 0,
    language: path.endsWith(".py") ? "python" : "typescript",
    source: "git",
  } as ChangedFile;
}

const SNAKE_SAMPLE = [
  "def load_order(order_path):",
  "    return order_path",
  "",
  "def save_order(order_payload):",
  "    return order_payload",
  "",
  "def total_for_items(order_items):",
  "    return order_items",
  "",
  "def find_customer(customer_id):",
  "    return customer_id",
  "",
  "def build_report(report_rows):",
  "    return report_rows",
  "",
  "def send_receipt(receipt_data):",
  "    return receipt_data",
  "",
  "def format_currency(amount_value):",
  "    return amount_value",
  "",
  "def validate_address(address_lines):",
  "    return address_lines",
].join("\n");

const PY_CAMEL_REPORT = [
  '"""Report export."""',
  "",
  "import requests",
  "",
  'REPORT_API = "https://reports.internal.example.com/v1/export"',
  "",
  "",
  "def getUserData(userId):",
  '    response = requests.get(f"{REPORT_API}/{userId}")',
  "    return response.json()",
  "",
  "",
  "def formatReport(userData):",
  "    # TODO: handle an empty report",
  '    return "\\n".join(row["name"] for row in userData["entries"])',
].join("\n");

interface Built {
  analysis: AnalysisReport;
  files: ChangedFile[];
  conventions: ConventionReference;
}

function build(files: ChangedFile[]): Built {
  const baseline = mergeProfiles([profileSource(SNAKE_SAMPLE, "python")]);
  return {
    analysis: analyseChanges({ files, baseline }),
    files,
    conventions: {
      source: "auto",
      baseline,
      summary: "snake_case naming, 4-space indent, double quotes",
      sampleFiles: ["app/orders.py", "app/pricing.py"],
      samples: [],
      styleGuide: null,
      styleGuidePath: null,
      cacheHit: false,
      warnings: [],
    },
  };
}

function dimensionScore(dimension: string, score: number, reason: string | null = null): DimensionScore {
  return {
    dimension,
    label: dimension,
    tier: "quality",
    kind: "score",
    score,
    threshold: 0.66,
    passed: false,
    weight: 2,
    confidence: 0.8,
    levelLabel: null,
    reason,
  };
}

function feedbackFor(
  built: Built,
  failed: DimensionScore[],
  options: { hardGates?: Parameters<typeof buildFeedback>[0]["hardGateFailures"]; task?: string } = {},
): FeedbackItem[] {
  return buildFeedback({
    scores: failed,
    failed,
    hardGateFailures: options.hardGates ?? [],
    analysis: built.analysis,
    files: built.files,
    conventions: built.conventions,
    testResults: null,
    config: defaultConfig("balanced"),
    taskDescription: options.task ?? "Add report export so a user can download their report as text.",
  });
}

/* ------------------------------------------------------------------ *
 * Identifier style conversion
 * ------------------------------------------------------------------ */

describe("identifier style conversion", () => {
  it("splits every style into the same words", () => {
    for (const name of ["getUserData", "get_user_data", "GET_USER_DATA", "get-user-data"]) {
      assert.deepEqual(splitWords(name), ["get", "user", "data"], name);
    }
  });

  it("converts between styles and preserves a leading underscore", () => {
    assert.equal(toStyle("getUserData", "snake_case"), "get_user_data");
    assert.equal(toStyle("get_user_data", "camelCase"), "getUserData");
    assert.equal(toStyle("_privateThing", "snake_case"), "_private_thing");
    assert.equal(toStyle("exportReport", "kebab-case"), "export-report");
  });
});

/* ------------------------------------------------------------------ *
 * Conventions
 * ------------------------------------------------------------------ */

describe("convention feedback", () => {
  it("names the offending identifiers and the exact rename", () => {
    const built = build([changed("app/reports.py", PY_CAMEL_REPORT)]);
    const [item] = feedbackFor(built, [dimensionScore("follows_conventions", 0.3, "naming_casing")]);

    assert.ok(item, "a failing dimension must produce feedback");
    assert.match(item.instruction, /snake_case/, "the instruction names the target style");
    const evidence = item.evidence.join("\n");
    assert.match(evidence, /getUserData/);
    assert.match(evidence, /get_user_data/, "the concrete rename is included");
    assert.match(evidence, /formatReport/);
    assert.match(evidence, /app\/reports\.py/, "the file is named");
    assert.ok(item.files.includes("app/reports.py"));
  });

  it("does not claim a convention problem when there is no measured divergence", () => {
    const clean = [
      '"""Report export."""',
      "",
      "",
      "def get_user_data(user_id):",
      "    return user_id",
      "",
      "",
      "def format_report(user_data):",
      "    return user_data",
    ].join("\n");
    const built = build([changed("app/reports.py", clean)]);
    assert.deepEqual(built.analysis.casingViolations, [], "snake_case code in a snake_case repo is consistent");

    const [item] = feedbackFor(built, [dimensionScore("follows_conventions", 0.3, null)]);
    assert.ok(item);
    assert.doesNotMatch(item.evidence.join("\n"), /rename to/, "no rename is invented");
  });
});

/* ------------------------------------------------------------------ *
 * Error handling
 * ------------------------------------------------------------------ */

describe("error handling feedback", () => {
  it("points at the exact call and the enclosing function", () => {
    const source = [
      "def get_user_data(user_id):",
      '    response = requests.get(f"{BASE}/users/{user_id}")',
      "    return response.json()",
    ].join("\n");
    const built = build([changed("app/reports.py", source)]);
    const [item] = feedbackFor(built, [dimensionScore("error_handling_present", 0.33, "missing_try_catch")]);

    assert.ok(item);
    assert.match(item.instruction, /try\/catch|try/, "the instruction asks for handling");
    const evidence = item.evidence.join("\n");
    assert.match(evidence, /app\/reports\.py:\d+/, "evidence carries a file and line");
    assert.match(evidence, /get_user_data\(\)/, "evidence names the enclosing function");
  });

  it("does not flag a call that is already guarded", () => {
    const source = [
      "def get_user_data(user_id):",
      "    try:",
      '        return requests.get(f"{BASE}/users/{user_id}")',
      "    except requests.RequestException as error:",
      '        raise RuntimeError("nope") from error',
    ].join("\n");
    const built = build([changed("app/reports.py", source)]);
    assert.deepEqual(built.analysis.unhandledAsync, []);
  });
});

/* ------------------------------------------------------------------ *
 * Debt
 * ------------------------------------------------------------------ */

describe("debt feedback", () => {
  it("quotes the marker with its location", () => {
    const built = build([changed("app/reports.py", PY_CAMEL_REPORT)]);
    const [item] = feedbackFor(built, [dimensionScore("introduces_debt", 0.23, "leftover_todo")]);
    assert.ok(item);
    assert.match(item.evidence.join("\n"), /app\/reports\.py:\d+/);
    assert.match(item.evidence.join("\n"), /TODO/);
  });

  it("tells the agent to move a hardcoded endpoint into configuration", () => {
    const built = build([changed("app/reports.py", PY_CAMEL_REPORT)]);
    const [item] = feedbackFor(built, [
      dimensionScore("introduces_debt", 0.3, "hardcoded_value_that_should_be_config"),
    ]);
    assert.ok(item);
    const evidence = item.evidence.join("\n");
    assert.match(evidence, /reports\.internal\.example\.com/, "the actual value is shown");
    assert.match(evidence, /endpoint URL/);
  });

  it("never echoes a credential it found", () => {
    const secret = "sk-live-9f8a7b6c5d4e3f2a1b0c";
    const source = `const apiKey = "${secret}";\n`;
    const built = build([changed("src/config.ts", source)]);
    const [item] = feedbackFor(built, [dimensionScore("introduces_debt", 0.2, "hardcoded_value_that_should_be_config")], {
      hardGates: [{ gate: "committed_secret", message: "secret found", evidence: ["src/config.ts:1 — sk-liv…[redacted]"] }],
    });
    assert.ok(item, "the hard gate produces feedback");
    assert.ok(
      !JSON.stringify(item).includes(secret),
      "the raw credential must never appear in the agent-facing feedback",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe("test feedback", () => {
  it("names the units that changed when there are no tests", () => {
    const built = build([changed("app/reports.py", PY_CAMEL_REPORT)]);
    const [item] = feedbackFor(built, [dimensionScore("test_coverage_adequate", 0.33, "no_tests_at_all")]);
    assert.ok(item);
    const evidence = item.evidence.join("\n");
    assert.match(evidence, /getUserData|formatReport/, "names the units that need tests");
    assert.match(item.instruction, /failure case/);
  });
});

/* ------------------------------------------------------------------ *
 * Ordering and honesty
 * ------------------------------------------------------------------ */

describe("feedback ordering and honesty", () => {
  const built = build([changed("app/reports.py", PY_CAMEL_REPORT)]);

  it("puts hard gate failures ahead of scored dimensions", () => {
    const items = feedbackFor(
      built,
      [dimensionScore("readability", 0.2, "unclear_names"), dimensionScore("satisfies_request", 0.2, null)],
      {
        hardGates: [
          {
            gate: "failing_tests",
            message: "tests are red",
            evidence: ["1 failed, 2 passed"],
          },
        ],
      },
    );
    assert.equal(items[0]?.dimension, "hard_gate:failing_tests", "a fact must outrank a judgment");
    assert.ok(items[0]!.severity > (items[1]?.severity ?? 0));
  });

  it("orders by severity, scaled by weight", () => {
    const items = feedbackFor(built, [
      dimensionScore("readability", 0.61, "unclear_names"),
      dimensionScore("satisfies_request", 0.1, null),
    ]);
    assert.equal(items[0]?.dimension, "satisfies_request");
    assert.ok(items[0]!.severity > items[1]!.severity);
  });

  it("emits an instruction and evidence for every failure", () => {
    const failureModes: [string, string][] = [
      ["satisfies_request", "stub_or_placeholder"],
      ["scope_appropriate", "over_delivered"],
      ["follows_conventions", "formatting"],
      ["separation_of_concerns", "god_function"],
      ["introduces_debt", "debug_output_left_behind"],
      ["readability", "overly_long_function"],
      ["error_handling_present", "missing_timeout"],
      ["test_coverage_adequate", "happy_path_only"],
    ];
    for (const [dimension, reason] of failureModes) {
      const [item] = feedbackFor(built, [dimensionScore(dimension, 0.3, reason)]);
      assert.ok(item, `${dimension} must produce feedback`);
      assert.ok(item.instruction.length > 40, `${dimension} instruction must be substantive`);
      assert.ok(item.evidence.length > 0, `${dimension} must cite evidence`);
      assert.ok(item.title.length > 0, `${dimension} must have a title`);
    }
  });

  it("produces an instruction even with no diagnostic reason at all", () => {
    for (const dimension of [
      "satisfies_request",
      "scope_appropriate",
      "follows_conventions",
      "separation_of_concerns",
      "introduces_debt",
      "readability",
      "error_handling_present",
      "test_coverage_adequate",
    ]) {
      const [item] = feedbackFor(built, [dimensionScore(dimension, 0.3, null)]);
      assert.ok(item, `${dimension} must produce feedback without a diagnostic`);
      assert.ok(item.evidence.length > 0, `${dimension} must still cite measured evidence`);
    }
  });

  it("treats an unnamed request failure as an evidence problem, not as a checklist", () => {
    const [item] = feedbackFor(built, [dimensionScore("satisfies_request", 0.3, null)]);
    assert.ok(item);
    // With no diagnostic there is no unmet requirement to name, so echoing the
    // request back would tell the agent to re-check what it already believes it did.
    assert.ok(
      !item.evidence.some((line) => line.startsWith("confirm this is implemented")),
      "the request must not be handed back as a checklist item",
    );
    assert.match(item.instruction, /notes/, "the agent is told how to make the request verifiable");
  });
});
