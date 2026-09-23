/**
 * Diff and status parsing tests.
 *
 * These parsers decide what the review says the change set *is*: how many lines
 * it added, which files are new, which are renames. Those numbers are handed to
 * the judge as the size of the change and quoted back to the agent as evidence,
 * so a silently zero count is a wrong verdict rather than a cosmetic slip - it
 * makes a 600-line change read as a one-line one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStatus, parseUnifiedDiff } from "../src/context/git.js";

const MODIFIED = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 111aaa1..222bbb2 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " ",
].join("\n");

const ADDED = [
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..333ccc3",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const one = 1;",
  "+export const two = 2;",
].join("\n");

const RENAMED = [
  "diff --git a/src/old.ts b/src/new.ts",
  "similarity index 90%",
  "rename from src/old.ts",
  "rename to src/new.ts",
  "@@ -1 +1 @@",
  "-const x = 1;",
  "+const x = 2;",
].join("\n");

const BINARY = [
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 1111111..2222222 100644",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
].join("\n");

describe("unified diff parsing", () => {
  it("counts the added and removed lines of a modification", () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    assert.ok(file);
    assert.equal(file.added, 2, "the `+++` header line must not be counted as an added line");
    assert.equal(file.removed, 1, "the `---` header line must not be counted as a removed line");
    assert.equal(file.status, "modified");
    assert.equal(file.path, "src/app.ts");
  });

  it("keeps the diff text intact for the judge to read", () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    assert.ok(file?.diff.startsWith("diff --git a/src/app.ts b/src/app.ts"));
    assert.ok(file?.diff.includes("@@ -1,3 +1,4 @@"), "the hunk header must survive parsing");
    assert.ok(file?.diff.includes("-const b = 2;"));
  });

  it("recognises a new file and counts its lines", () => {
    const [file] = parseUnifiedDiff(ADDED);
    assert.ok(file);
    assert.equal(file.status, "added");
    assert.equal(file.added, 2);
    assert.equal(file.removed, 0);
  });

  it("recognises a rename and keeps both paths", () => {
    const [file] = parseUnifiedDiff(RENAMED);
    assert.ok(file);
    assert.equal(file.status, "renamed");
    assert.equal(file.path, "src/new.ts");
    assert.equal(file.oldPath, "src/old.ts");
    assert.equal(file.added, 1);
    assert.equal(file.removed, 1);
  });

  it("reports a binary file without inventing line counts", () => {
    const [file] = parseUnifiedDiff(BINARY);
    assert.ok(file);
    assert.equal(file.binary, true);
    assert.equal(file.added, 0);
    assert.equal(file.removed, 0);
  });

  it("splits a multi-file diff into one entry per file", () => {
    const files = parseUnifiedDiff(`${MODIFIED}\n${ADDED}\n${BINARY}`);
    assert.deepEqual(
      files.map((file) => file.path),
      ["src/app.ts", "src/new.ts", "assets/logo.png"],
    );
    assert.equal(
      files.reduce((total, file) => total + file.added, 0),
      4,
      "per-file counts must sum to the whole change",
    );
  });

  it("returns nothing for empty input", () => {
    assert.deepEqual(parseUnifiedDiff(""), []);
    assert.deepEqual(parseUnifiedDiff("\n \n"), []);
  });
});

describe("working-tree status parsing", () => {
  it("classifies the porcelain codes the scope depends on", () => {
    const entries = parseStatus(
      [" M src/app.ts", "?? src/new.ts", "A  src/staged.ts", "D  src/gone.ts", "R  src/old.ts -> src/moved.ts"].join("\n"),
    );
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("src/app.ts")?.status, "modified");
    assert.equal(byPath.get("src/new.ts")?.status, "added");
    assert.equal(byPath.get("src/staged.ts")?.status, "added");
    assert.equal(byPath.get("src/gone.ts")?.status, "deleted");
    assert.equal(byPath.get("src/moved.ts")?.status, "renamed");
    assert.equal(byPath.get("src/moved.ts")?.oldPath, "src/old.ts");
  });

  it("ignores blank and malformed lines", () => {
    assert.deepEqual(parseStatus("\n  \n"), []);
  });
});
