/**
 * Pattern tests.
 *
 * This file exists because of a real failure during development: an escaping
 * mistake turned a set of detectors into silent no-ops. Nothing threw, nothing
 * looked wrong, and the review simply stopped noticing whole classes of problem.
 * Type checking cannot catch that, so every pattern is asserted here against a
 * representative sample, and against the case it must NOT match.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AWAIT_CALL,
  BENIGN_URL,
  CATCH_HANDLER,
  EMPTY_CATCH,
  EMPTY_CATCH_LINE,
  FALLIBLE_JS_CALL,
  FALLIBLE_PY_CALL,
  identifierWords,
  isNamedConstantLine,
  mentionsTunableName,
  NETWORK_CALL,
  PLACEHOLDER_VALUE,
  PY_EXCEPT_CLAUSE,
  PY_PASS,
  RETHROW,
  SECRET_PATTERNS,
  TRY_BLOCK_JS,
  TRY_BLOCK_PY,
  tunableNumbersIn,
  UNTRUSTED_INPUT,
} from "../src/context/patterns.js";

describe("fallible call detection", () => {
  it("matches JS calls that can fail at runtime", () => {
    for (const line of [
      '  fetch("/x");',
      '  const response = await fetch("/x");',
      "  return response.json();",
      "  const parsed = JSON.parse(raw);",
      "  const text = readFileSync(path, 'utf8');",
    ]) {
      assert.ok(FALLIBLE_JS_CALL.test(line), line);
    }
  });

  it("does not match ordinary JS", () => {
    for (const line of ["  const total = a + b;", "  return items.length;", "  logger.info('done');"]) {
      assert.equal(FALLIBLE_JS_CALL.test(line), false, line);
    }
  });

  it("matches Python calls that can fail at runtime", () => {
    for (const line of [
      "    response = requests.get(url)",
      '    with open(path, "w") as handle:',
      "    payload = json.load(handle)",
      "    os.remove(temp_path)",
    ]) {
      assert.ok(FALLIBLE_PY_CALL.test(line), line);
    }
  });

  it("does not match ordinary Python", () => {
    assert.equal(FALLIBLE_PY_CALL.test("    print(value)"), false);
    assert.equal(FALLIBLE_PY_CALL.test("    return total"), false);
  });
});

describe("handling detection", () => {
  it("detects awaits, try blocks and catch handlers", () => {
    assert.ok(AWAIT_CALL.test("  await save();"));
    assert.equal(AWAIT_CALL.test("  save();"), false);
    assert.ok(TRY_BLOCK_JS.test("  try {"));
    assert.ok(TRY_BLOCK_PY.test("    try:"));
    assert.ok(CATCH_HANDLER.test("  fetch(url).catch(handle);"));
    assert.equal(CATCH_HANDLER.test("  fetch(url);"), false);
  });

  it("detects rethrows, which mean a failure may be surfaced deliberately", () => {
    assert.ok(RETHROW.test("    throw new Error('x');"));
    assert.ok(RETHROW.test("        raise RuntimeError('x')"));
    assert.equal(RETHROW.test("    return 1;"), false);
  });

  it("detects empty catch blocks", () => {
    assert.ok(EMPTY_CATCH.test("  } catch (error) { }"));
    assert.ok(EMPTY_CATCH.test("  } catch {  }"));
    assert.equal(EMPTY_CATCH.test("  } catch (error) { report(error); }"), false);
  });

  it("detects network calls and untrusted input", () => {
    assert.ok(NETWORK_CALL.test("  await fetch(url, options);"));
    assert.ok(UNTRUSTED_INPUT.test("  const body = JSON.parse(raw);"));
    assert.ok(UNTRUSTED_INPUT.test("    for value in sys.argv:"));
  });
});

describe("URL and placeholder rules", () => {
  it("exempts genuinely value-free namespaces only", () => {
    assert.ok(BENIGN_URL.test("http://www.w3.org/2000/svg"));
    assert.ok(BENIGN_URL.test("https://example.com/x"));
    // Anchored, so a real endpoint under an example.com subdomain is still a
    // hardcoded endpoint.
    assert.equal(BENIGN_URL.test("https://reports.internal.example.com/v1"), false);
  });

  it("treats environment lookups and obvious placeholders as not secrets", () => {
    assert.ok(PLACEHOLDER_VALUE.test('const apiKey = process.env.API_KEY ?? "";'));
    assert.ok(PLACEHOLDER_VALUE.test('const apiKey = "YOUR_API_KEY_HERE";'));
    assert.equal(PLACEHOLDER_VALUE.test('const username = "reporter";'), false);
  });

  it("recognises credential shapes", () => {
    assert.ok(SECRET_PATTERNS.some((pattern) => pattern.test('const apiKey = "sk-live-9f8a7b6c5d4e3f2a1b0c";')));
    assert.ok(SECRET_PATTERNS.some((pattern) => pattern.test("-----BEGIN RSA PRIVATE KEY-----")));
    assert.equal(SECRET_PATTERNS.some((pattern) => pattern.test('const name = "report";')), false);
  });
});

describe("empty catch clause detection", () => {
  it("matches JS one-line empty catch blocks", () => {
    for (const line of [
      "  catch {}",
      "  } catch {}",
      "  } catch (error) {}",
      "  } catch (error: unknown) {}",
    ]) {
      assert.ok(EMPTY_CATCH.test(line), line);
    }
  });

  it("does not match a catch block with a body", () => {
    assert.equal(EMPTY_CATCH.test('  } catch (error) { log(error); }'), false);
  });

  it("matches the opening of a JS multi-line empty catch", () => {
    for (const line of ["  } catch (error) {", "  } catch {", "  try {\n  } catch (e) {"]) {
      assert.ok(/catch\s*(?:\([^)]*\))?\s*\{$/.test(line), line);
    }
  });

  it("matches Python except clauses and pass bodies", () => {
    assert.ok(PY_EXCEPT_CLAUSE.test("    except:"));
    assert.ok(PY_EXCEPT_CLAUSE.test("    except Exception:"));
    assert.ok(PY_EXCEPT_CLAUSE.test("    except (OSError, ValueError) as error:"));
    assert.equal(PY_EXCEPT_CLAUSE.test("    except: pass"), false, "one-line except:pass is a separate shape");
    assert.ok(PY_PASS.test("        pass"));
    assert.equal(PY_PASS.test("        process(data)"), false);
  });

  it("EMPTY_CATCH_LINE recognises both stacks' silent shapes", () => {
    assert.ok(EMPTY_CATCH_LINE.test("  } catch {}"));
    assert.ok(EMPTY_CATCH_LINE.test("    except: pass"));
    assert.ok(EMPTY_CATCH_LINE.test("    except:"));
  });
});

describe("identifier words", () => {
  it("splits every naming style into the same words", () => {
    for (const name of ["retryDelayMs", "retry_delay_ms", "RETRY_DELAY_MS", "retry-delay-ms"]) {
      assert.deepEqual(identifierWords(name), ["retry", "delay", "ms"], name);
    }
  });

  it("recognises tunable names however they are written", () => {
    for (const text of ["const retryDelayMs = 1;", "base_delay_ms = 1", "MAX_TIMEOUT = 1", "pageSize: 1"]) {
      assert.ok(mentionsTunableName(text), text);
    }
  });

  it("does not fire on words that merely contain a tunable word", () => {
    // "admin" contains "min" but is not a tunable name.
    assert.equal(mentionsTunableName("const adminTotal = 1;"), false);
    assert.equal(mentionsTunableName("const remain = 1;"), false);
  });
});

describe("named constants and numbers", () => {
  it("exempts a number that has already been given a name", () => {
    assert.ok(isNamedConstantLine("  const retryDelayMs = 30000;"));
    assert.ok(isNamedConstantLine("  timeoutMs: 5_000,"));
    assert.ok(isNamedConstantLine("MAX_DELAY_MS = 30000"));
    assert.equal(isNamedConstantLine("  return attempt * 30000;"), false);
  });

  it("finds tunable numbers, tolerating digit separators", () => {
    assert.deepEqual(tunableNumbersIn("  return attempt * 30000;"), ["30000"]);
    assert.deepEqual(tunableNumbersIn("  const wait = 30_000;"), ["30_000"]);
    assert.deepEqual(tunableNumbersIn("  for (let i = 0; i < 10; i++) {}"), []);
    assert.deepEqual(tunableNumbersIn("  const year = 2026;"), []);
  });
});
