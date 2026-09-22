import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { candidateEnvFiles, loadDotEnvFiles, parseDotEnv } from "../src/env.js";

const TMP_ROOT = path.resolve(process.cwd(), ".tmp-tests");
const touched: string[] = [];
const dirs: string[] = [];

after(() => {
  for (const key of touched) delete process.env[key];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory holding one `.env` file, isolated from the repository root. */
function tempDirWithEnv(contents: string | null): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "env-"));
  dirs.push(dir);
  if (contents !== null) fs.writeFileSync(path.join(dir, ".env"), contents, "utf8");
  return dir;
}

function track(key: string, value?: string): string {
  touched.push(key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return key;
}

describe("parseDotEnv", () => {
  it("reads plain, exported, quoted and commented values", () => {
    const parsed = parseDotEnv(
      [
        "# a comment",
        "",
        "PLAIN=value",
        "export EXPORTED=other",
        'DOUBLE="quoted value"',
        "SINGLE='single quoted'",
        "INLINE=trailing  # not part of the value",
        "UNQUOTED_HASH=abc#def",
      ].join("\n"),
    );

    assert.deepEqual(parsed, {
      PLAIN: "value",
      EXPORTED: "other",
      DOUBLE: "quoted value",
      SINGLE: "single quoted",
      INLINE: "trailing",
      UNQUOTED_HASH: "abc#def",
    });
  });

  it("skips malformed lines instead of throwing", () => {
    const parsed = parseDotEnv(["no separator here", "=novalue", "1BAD=x", "GOOD=1"].join("\n"));
    assert.deepEqual(parsed, { GOOD: "1" });
  });

  it("keeps an empty assignment empty", () => {
    assert.deepEqual(parseDotEnv("TYPESAFE_API_KEY=\n"), { TYPESAFE_API_KEY: "" });
  });

  it("tolerates CRLF line endings", () => {
    assert.deepEqual(parseDotEnv("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
  });
});

describe("candidateEnvFiles", () => {
  it("checks the explicit file, then the cwd, then the package root", () => {
    const dir = tempDirWithEnv(null);
    const candidates = candidateEnvFiles({ cwd: dir });

    assert.equal(candidates.length, 2);
    assert.equal(candidates[0], path.join(dir, ".env"));
    const packageRoot = candidates[1] ?? "";
    assert.ok(packageRoot.endsWith(".env"));
    assert.ok(!packageRoot.startsWith(dir));
  });

  it("honours VIBECHECK_ENV_FILE ahead of the cwd file, and can skip the package root", () => {
    const dir = tempDirWithEnv(null);
    const candidates = candidateEnvFiles({ cwd: dir, envFile: "secrets/.env", skipPackageRoot: true });
    assert.deepEqual(candidates, [path.join(dir, "secrets", ".env"), path.join(dir, ".env")]);
  });
});

describe("loadDotEnvFiles", () => {
  it("applies values from the cwd and reports names only, never values", () => {
    const key = track("VIBECHECK_TEST_LOADED");
    const dir = tempDirWithEnv(`${key}=from-file\n`);

    const result = loadDotEnvFiles({ cwd: dir, skipPackageRoot: true });

    assert.equal(process.env[key], "from-file");
    assert.deepEqual(result.keys, [key]);
    assert.deepEqual(result.loaded, [path.join(dir, ".env")]);
    assert.ok(!JSON.stringify(result).includes("from-file"), "the loader must not carry values");
  });

  it("lets a real environment variable win over the file", () => {
    const key = track("VIBECHECK_TEST_PRECEDENCE", "from-env");
    const dir = tempDirWithEnv(`${key}=from-file\n`);

    loadDotEnvFiles({ cwd: dir, skipPackageRoot: true });

    assert.equal(process.env[key], "from-env");
  });

  it("does not let an empty environment variable mask a populated file", () => {
    const key = track("VIBECHECK_TEST_EMPTY_ENV", "");
    const dir = tempDirWithEnv(`${key}=from-file\n`);

    loadDotEnvFiles({ cwd: dir, skipPackageRoot: true });

    assert.equal(process.env[key], "from-file");
  });

  it("is a no-op when no file exists", () => {
    const dir = tempDirWithEnv(null);
    const result = loadDotEnvFiles({ cwd: dir, skipPackageRoot: true });

    assert.deepEqual(result, { loaded: [], keys: [] });
  });

  it("does not overwrite a value already applied by an earlier file", () => {
    const key = track("VIBECHECK_TEST_FIRST_WINS");
    const dir = tempDirWithEnv(`${key}=first\n`);
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nested", ".env"), `${key}=second\n`, "utf8");

    const result = loadDotEnvFiles({ cwd: dir, envFile: ".env" });

    assert.equal(process.env[key], "first");
    assert.deepEqual(result.keys, [key]);
  });
});
