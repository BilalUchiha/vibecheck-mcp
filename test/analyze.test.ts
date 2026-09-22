/**
 * Analyzer tests.
 *
 * These are the load-bearing tests for feedback quality: every concrete
 * instruction the agent sees is derived from a signal produced here, so a
 * regression in the analyzer becomes a vague or wrong instruction downstream.
 * Both directions matter - a missed signal produces generic advice, and a false
 * positive produces an accusation about code that is fine.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyseChanges,
  findCasingViolations,
  findHardcoded,
  findRisks,
  findSwallowedErrors,
  findUnhandledAsync,
  maxNestingDepthOf,
  mergeProfiles,
  profileSource,
} from "../src/context/analyze.js";
import { classifyCasing, classifyCasing as casing, extractDeclarations, stripCode } from "../src/context/lang.js";
import type { ChangedFile } from "../src/types.js";

function changed(path: string, content: string, options: Partial<ChangedFile> = {}): ChangedFile {
  const language = path.endsWith(".py") ? "python" : "typescript";
  return {
    path,
    status: "added",
    content,
    added: content.split("\n").length,
    removed: 0,
    language,
    source: "git",
    ...options,
  } as ChangedFile;
}

/* ------------------------------------------------------------------ *
 * Casing classification
 * ------------------------------------------------------------------ */

describe("casing classification", () => {
  it("identifies discriminating styles", () => {
    assert.equal(casing("getUserData"), "camelCase");
    assert.equal(casing("get_user_data"), "snake_case");
    assert.equal(casing("UserReport"), "PascalCase");
    assert.equal(casing("MAX_RETRIES"), "SCREAMING_SNAKE_CASE");
    assert.equal(casing("some-component"), "kebab-case");
  });

  it("treats casing-neutral names as unclassified", () => {
    // A single lowercase word is valid in both camelCase and snake_case, so it
    // carries no signal and must not vote in the style profile.
    for (const name of ["data", "path", "id", "_private", "value"]) {
      assert.equal(classifyCasing(name), "unknown", `${name} should be neutral`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Stripping, declarations, nesting
 * ------------------------------------------------------------------ */

describe("source stripping", () => {
  it("keeps line numbers stable and removes string bodies", () => {
    const source = ['const a = "not a // comment";', "// real comment", "const b = 1;"].join("\n");
    const stripped = stripCode(source, "typescript");
    assert.equal(stripped.split("\n").length, 3);
    assert.ok(!stripped.includes("not a"), "string body should be blanked");
    assert.ok(!stripped.includes("real comment"), "comment should be blanked");
    assert.ok(stripped.includes("const b = 1;"), "code should survive");
  });

  it("does not mistake a regex literal for a line comment", () => {
    const source = 'const url = "x";\nconst re = /https?:\\/\\//;\nconst after = 42;\n';
    const stripped = stripCode(source, "typescript");
    assert.ok(stripped.includes("after"), "code following a regex literal must survive");
  });

  it("can keep strings while blanking comments, so literals can be inspected", () => {
    const source = 'const url = "https://api.internal/v1"; // https://ignored.example\n';
    const stripped = stripCode(source, "typescript", { blankStrings: false, blankComments: true });
    assert.ok(stripped.includes("https://api.internal/v1"));
    assert.ok(!stripped.includes("https://ignored.example"));
  });

  it("extracts declarations with real line numbers", () => {
    const source = ["function alpha() {}", "", "function beta() {}"].join("\n");
    const declarations = extractDeclarations(source, "typescript");
    assert.equal(declarations.find((entry) => entry.name === "beta")?.line, 3);
  });

  it("measures nesting depth", () => {
    assert.equal(maxNestingDepthOf("function a() {\n  return 1;\n}", "typescript"), 1);
    assert.ok(maxNestingDepthOf("function a() {\n  if (x) {\n    for (;;) {\n      y();\n    }\n  }\n}", "typescript") >= 3);
  });
});

/* ------------------------------------------------------------------ *
 * Style profiling and convention comparison
 * ------------------------------------------------------------------ */

describe("style profiling", () => {
  // A realistic sample: the analyzer deliberately refuses to call something a
  // convention from two or three declarations.
  const baseline = mergeProfiles([
    profileSource(
      [
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
      ].join("\n"),
      "python",
    ),
  ]);

  it("finds snake_case in a snake_case sample", () => {
    assert.equal(baseline.dominantCasing, "snake_case");
    assert.equal(baseline.semicolons, null, "semicolons are not a Python convention");
  });

  it("flags camelCase declarations but not PascalCase classes", () => {
    const violations = findCasingViolations(
      [
        {
          path: "app/reports.py",
          content: ["def getUserData(userId):", "    return userId", "", "class ReportBuilder:", "    pass"].join("\n"),
          language: "python",
          consideredLines: null,
        },
      ],
      baseline,
    );
    const names = violations.map((violation) => violation.name);
    assert.ok(names.includes("getUserData"), "camelCase function should be flagged");
    assert.ok(!names.includes("ReportBuilder"), "PascalCase classes are expected in every stack");
    assert.ok(violations.every((violation) => violation.expected === "snake_case"));
  });

  it("stays silent when the baseline is too small or inconsistent to call a convention", () => {
    const thin = mergeProfiles([profileSource("def a_thing():\n    pass", "python")]);
    const violations = findCasingViolations(
      [{ path: "x.py", content: "def getThing():\n    pass", language: "python", consideredLines: null }],
      thin,
    );
    assert.deepEqual(violations, [], "one declaration is not a convention");
  });
});

/* ------------------------------------------------------------------ *
 * Risk markers
 * ------------------------------------------------------------------ */

describe("risk markers", () => {
  it("finds markers that live in comments", () => {
    const risks = findRisks("a.py", "# TODO: handle empty input\n# FIXME later\nx = 1\n", "python", null);
    assert.deepEqual(risks.map((risk) => risk.kind).sort(), ["fixme", "todo"]);
  });

  it("finds weakened checks and debug output in code", () => {
    const source = ["it.skip(\"x\", () => {});", "console.log(\"debug\");", "debugger;", "const y: any = 1;"].join("\n");
    const kinds = findRisks("a.test.ts", source, "typescript", null).map((risk) => risk.kind).sort();
    assert.ok(kinds.includes("skipped-test"));
    assert.ok(kinds.includes("console-log"));
    assert.ok(kinds.includes("debugger-statement"));
    assert.ok(kinds.includes("loose-any"));
  });

  it("ignores a marker that appears only inside a string literal", () => {
    const risks = findRisks("a.ts", 'const message = "TODO: not real";\n', "typescript", null);
    assert.deepEqual(risks, []);
  });

  it("only reports markers on added lines when a diff is supplied", () => {
    const risks = findRisks("a.ts", "// TODO existing\n\n// TODO new\n", "typescript", new Set([3]));
    assert.equal(risks.length, 1);
    assert.equal(risks[0]?.line, 3);
  });
});

/* ------------------------------------------------------------------ *
 * Hardcoded values
 * ------------------------------------------------------------------ */

describe("hardcoded values", () => {
  it("finds an endpoint URL, including one under an example.com subdomain", () => {
    const found = findHardcoded("a.py", 'API = "https://reports.internal.example.com/v1/export"\n', "python", null);
    assert.ok(found.some((value) => value.kind === "url"));
  });

  it("exempts genuinely value-free namespaces", () => {
    const found = findHardcoded("a.ts", 'const ns = "http://www.w3.org/2000/svg";\n', "typescript", null);
    assert.deepEqual(found, []);
  });

  it("redacts a credential instead of echoing it", () => {
    const secret = "sk-live-9f8a7b6c5d4e3f2a1b0c";
    const found = findHardcoded("a.ts", `const apiKey = "${secret}";\n`, "typescript", null);
    const match = found.find((value) => value.kind === "secret");
    assert.ok(match, "a credential-shaped literal must be reported");
    assert.ok(match.redacted);
    assert.ok(!match.text.includes(secret), "the raw credential must never be echoed back");
  });

  it("ignores placeholders and environment lookups", () => {
    for (const line of [
      'const apiKey = process.env.API_KEY ?? "";',
      'const apiKey = "YOUR_API_KEY_HERE";',
      'const apiKey = "changeme";',
    ]) {
      const found = findHardcoded("a.ts", `${line}\n`, "typescript", null);
      assert.equal(found.filter((value) => value.kind === "secret").length, 0, line);
    }
  });

  it("reports a magic number used in an expression but not one already named", () => {
    const inline = findHardcoded("a.ts", "export function retryDelay(attempt: number) {\n  return attempt * 30000;\n}\n", "typescript", null);
    assert.ok(inline.some((value) => value.kind === "magic-number"), "an inline tunable number should be flagged");

    const named = findHardcoded("a.ts", "const retryDelayMs = 30000;\n", "typescript", null);
    assert.equal(named.filter((value) => value.kind === "magic-number").length, 0, "naming the number is the fix");

    const property = findHardcoded("a.ts", "const config = {\n  timeoutMs: 5_000,\n};\n", "typescript", null);
    assert.equal(property.filter((value) => value.kind === "magic-number").length, 0, "an object property literal is configuration");
  });

  it("stays quiet inside test files", () => {
    const found = findHardcoded("a.test.ts", "expect(retryDelay(20)).toBeLessThanOrEqual(30_000);\n", "typescript", null);
    assert.equal(found.filter((value) => value.kind === "magic-number").length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Async failure handling
 * ------------------------------------------------------------------ */

describe("async failure handling", () => {
  it("flags an awaited call with no try/catch", () => {
    const source = "export async function load() {\n  const r = await fetch(\"/x\");\n  return r;\n}\n";
    const found = findUnhandledAsync("a.ts", source, "typescript", null);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.kind, "await_without_try");
    assert.equal(found[0]?.container, "load()");
  });

  it("accepts an awaited call inside try/catch", () => {
    const source =
      "export async function load() {\n  try {\n    return await fetch(\"/x\");\n  } catch (e) {\n    throw new Error(String(e));\n  }\n}\n";
    assert.deepEqual(findUnhandledAsync("a.ts", source, "typescript", null), []);
  });

  it("flags a discarded promise, which cannot report its failure at all", () => {
    const source = "export function load() {\n  fetch(\"/x\");\n  return 1;\n}\n";
    const found = findUnhandledAsync("a.ts", source, "typescript", null);
    assert.equal(found[0]?.kind, "floating_promise");
  });

  it("flags a fallible Python call with no try/except", () => {
    const source = "def load(user_id):\n    response = requests.get(URL)\n    return response.json()\n";
    const found = findUnhandledAsync("a.py", source, "python", null);
    assert.ok(found.some((item) => item.kind === "fallible_call_without_try"));
    assert.equal(found[0]?.container, "load()");
  });

  it("accepts a fallible Python call inside try/except", () => {
    const source = [
      "def load(user_id):",
      "    try:",
      "        return requests.get(URL)",
      "    except requests.RequestException as error:",
      "        raise RuntimeError('nope') from error",
    ].join("\n");
    assert.deepEqual(findUnhandledAsync("a.py", source, "python", null), []);
  });

  it("records whether the enclosing function rethrows, so propagation is not mistaken for neglect", () => {
    const source = [
      "export async function load() {",
      "  const r = await fetch('/x');",
      "  if (!r.ok) {",
      "    throw new Error('bad');",
      "  }",
      "  return r;",
      "}",
    ].join("\n");
    const found = findUnhandledAsync("a.ts", source, "typescript", null);
    assert.equal(found[0]?.propagates, true);
  });
});

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

describe("change-set aggregation", () => {
  it("counts assertions and spots assertion-less and skipped tests", () => {
    const source = [
      "def test_checks_a_value():",
      "    assert compute() == 2",
      "",
      "@pytest.mark.skip",
      "def test_never_runs():",
      "    pass",
    ].join("\n");
    const report = analyseChanges({ files: [changed("tests/test_x.py", source)], baseline: null });
    assert.equal(report.tests.testFilesChanged.length, 1);
    assert.ok(report.tests.assertions >= 1);
    assert.equal(report.tests.skippedTests, 1);
    assert.equal(report.tests.assertionlessTests, 1, "the skipped test asserts nothing");
  });

  it("reports a function that has grown too large", () => {
    const body = Array.from({ length: 70 }, (_, index) => `  const v${index} = ${index};`).join("\n");
    const report = analyseChanges({
      files: [changed("src/big.ts", `export function huge() {\n${body}\n}\n`)],
      baseline: null,
    });
    assert.equal(report.godFunctions.length, 1);
    assert.equal(report.godFunctions[0]?.name, "huge");
  });

  it("counts totals and languages", () => {
    const report = analyseChanges({
      files: [changed("a.ts", "const a = 1;\n"), changed("b.py", "a = 1\n"), changed("c.md", "# hi\n")],
      baseline: null,
    });
    assert.equal(report.totals.filesChanged, 3);
    assert.ok(report.totals.languages.includes("typescript"));
    assert.ok(report.totals.languages.includes("python"));
  });
});

/* ------------------------------------------------------------------ *
 * Swallowed errors
 * ------------------------------------------------------------------ */

describe("swallowed error detection", () => {
  it("finds JS one-line empty catch blocks", () => {
    const code = [
      "export function load(path: string): unknown {",
      "  try {",
      "    return JSON.parse(readFileSync(path, 'utf8'));",
      "  } catch {",
      "    return null;",
      "  }",
      "}",
      "",
      "export function probe(url: string): void {",
      "  try { fetch(url); } catch {}",
      "}",
    ].join("\n");
    const findings = findSwallowedErrors("src/x.ts", code, "typescript", null);

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.line, 10);
    assert.match(findings[0]?.excerpt ?? "", /catch block swallows/);
  });

  it("finds a JS multi-line catch whose body is empty or comment-only", () => {
    const empty = [
      "function a() {",
      "  try { work(); }",
      "  catch (error) {",
      "  }",
      "}",
    ].join("\n");
    const commented = [
      "function b() {",
      "  try { work(); }",
      "  catch (error) {",
      "    // nothing to do here",
      "  }",
      "}",
    ].join("\n");

    const emptyFindings = findSwallowedErrors("src/y.ts", empty, "typescript", null);
    assert.equal(emptyFindings.length, 1);
    assert.equal(emptyFindings[0]?.partiallyHandled, false);

    const commentedFindings = findSwallowedErrors("src/y.ts", commented, "typescript", null);
    assert.equal(commentedFindings.length, 1);
    assert.equal(commentedFindings[0]?.partiallyHandled, true, "a comment explains, but the error is still swallowed");
  });

  it("does not accuse a catch block that handles the error", () => {
    const code = [
      "function a() {",
      "  try { work(); }",
      "  catch (error) {",
      "    log.error('work failed', error);",
      "    throw error;",
      "  }",
      "}",
    ].join("\n");
    assert.equal(findSwallowedErrors("src/z.ts", code, "typescript", null).length, 0);
  });

  it("finds Python bare except: pass, one-line and multi-line", () => {
    const oneLine = "try:\n    process()\nexcept: pass\n";
    const multi = "try:\n    process()\nexcept Exception:\n    pass\n";

    const one = findSwallowedErrors("a.py", oneLine, "python", null);
    assert.equal(one.length, 1);
    assert.equal(one[0]?.line, 3);
    assert.equal(one[0]?.partiallyHandled, false);

    const multiFindings = findSwallowedErrors("a.py", multi, "python", null);
    assert.equal(multiFindings.length, 1);
    assert.equal(multiFindings[0]?.line, 3);
    assert.match(multiFindings[0]?.excerpt ?? "", /only `pass`/);
  });

  it("surfaces but does not accuse a Python except that rethrows or logs", () => {
    const rethrows = "try:\n    work()\nexcept OSError:\n    raise\n";
    const logs = "try:\n    work()\nexcept OSError as error:\n    logger.warning('work failed: %s', error)\n";

    // Both are recorded so the judge sees the handling, but marked
    // partiallyHandled: the feedback layer filters them out of the fix list,
    // because propagating or logging is a defensible choice, not a swallow.
    for (const code of [rethrows, logs]) {
      const findings = findSwallowedErrors("a.py", code, "python", null);
      assert.equal(findings.length, 1, code);
      assert.equal(findings[0]?.partiallyHandled, true, code);
    }

    // The damning category stays empty for both.
    const silent = [rethrows, logs].flatMap((code) =>
      findSwallowedErrors("a.py", code, "python", null).filter((finding) => !finding.partiallyHandled),
    );
    assert.equal(silent.length, 0);
  });

  it("respects the considered-lines scope when a diff is present", () => {
    // Lines 1-2 exist but were not added in this change; line 3 (the empty
    // catch) was. With the diff scope, only line 3 may be reported.
    const code = "function a() {\n  try { work(); }\n  catch {}\n}\n";
    const scope = new Set([3]);
    const findings = findSwallowedErrors("a.ts", code, "typescript", scope);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.line, 3);
  });

  it("flows through analyseChanges into the report", () => {
    const report = analyseChanges({
      files: [changed("src/flaky.ts", "try { work(); } catch {}\n")],
      baseline: null,
    });
    assert.equal(report.swallowedErrors.length, 1);
    assert.equal(report.swallowedErrors[0]?.partiallyHandled, false);
  });
});
