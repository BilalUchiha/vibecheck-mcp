/**
 * Plumbing test: the agent-facing contract.
 *
 * This is the step-1 goal - prove the transport and tool wiring work end to end
 * before any judgment happens - extended to check that the real tool call
 * returns a structured verdict over the wire.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeSnakeCasePythonRepo, PY_BAD_REPORT, type TempRepo } from "./helpers/fixture.js";

let repo: TempRepo;
let client: Client;

describe("MCP plumbing", () => {
  before(async () => {
    // Force the offline judge so the test never depends on network access.
    delete process.env.TYPESAFE_API_KEY;
    process.env.VIBECHECK_JUDGE = "mock";
    process.env.VIBECHECK_LOG_LEVEL = "silent";

    repo = makeSnakeCasePythonRepo();
    repo.write("app/reports.py", PY_BAD_REPORT);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      env: { ...process.env, VIBECHECK_JUDGE: "mock", VIBECHECK_LOG_LEVEL: "silent" } as Record<string, string>,
      stderr: "ignore",
    });
    client = new Client({ name: "vibecheck-test", version: "0.0.0" });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
    repo?.dispose();
  });

  it("advertises the three tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["configure_project", "get_review_log", "submit_for_review"]);

    const submit = tools.find((tool) => tool.name === "submit_for_review");
    assert.ok(submit, "submit_for_review must be advertised");
    assert.ok(submit.inputSchema);
    const properties = (submit.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok("task_description" in properties, "task_description is a required input");
  });

  it("returns a structured verdict from a real submission", async () => {
    const result = await client.callTool({
      name: "submit_for_review",
      arguments: {
        task_description: "Add report export so users can download their report as text.",
        project_root: repo.root,
      },
    });

    const structured = result.structuredContent as Record<string, unknown> | undefined;
    assert.ok(structured, "the tool must return structured content for machine callers");
    assert.ok(["approved", "needs_fixes", "max_retries_exceeded", "review_unavailable"].includes(String(structured.verdict)));
    assert.equal(typeof structured.attempts_remaining, "number");
    assert.equal(typeof structured.attempt_number, "number");

    const evidence = structured.evidence as { scope?: { rule?: string } } | undefined;
    assert.ok(evidence?.scope?.rule, "the verdict must disclose which commits were reviewed");

    const textBlock = (result.content as { type: string; text: string }[]).find((block) => block.type === "text");
    assert.ok(textBlock?.text.includes("vibe-check"), "the text content must carry a readable verdict");
  });

  it("exposes the review log over the wire", async () => {
    const result = await client.callTool({
      name: "get_review_log",
      arguments: { project_root: repo.root, limit: 5 },
    });
    const textBlock = (result.content as { type: string; text: string }[]).find((block) => block.type === "text");
    assert.match(textBlock?.text ?? "", /Reviews recorded/);
  });
});
