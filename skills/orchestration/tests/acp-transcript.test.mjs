import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAcpTranscript, readAcpTranscript } from "../scripts/lib/acp-transcript.mjs";

function event(value) {
  return `${JSON.stringify(value)}\n`;
}

test("an ACP log becomes messages, tools and plans", () => {
  const log =
    event({ type: "acp.session", mode: "new", sessionId: "ses_demo" }) +
    event({ type: "acp.update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Inspecting." } } }) +
    event({ type: "acp.update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read index.html", kind: "read", status: "pending" } }) +
    event({ type: "acp.update", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } }) +
    event({ type: "acp.update", update: { sessionUpdate: "plan", entries: [{ content: "Check the page", status: "completed" }] } });
  const parsed = parseAcpTranscript(log);
  assert.equal(parsed.session.id, "ses_demo");
  assert.equal(parsed.messages[0].role, "assistant");
  assert.equal(parsed.messages[0].text, "Inspecting.");
  assert.equal(parsed.messages[1].role, "tool");
  assert.match(parsed.messages[1].text, /Read index\.html/);
  assert.match(parsed.messages[1].text, /completed/);
  assert.equal(parsed.messages[2].role, "plan");
  assert.match(parsed.messages[2].text, /Check the page/);
});

test("readAcpTranscript resolves a run inside the campaign state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-acp-"));
  const run = "r-20260101-demo-01-work-1";
  const dir = path.join(root, ".orchestration", "campaigns", "demo", "runs", run);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "log.jsonl"), event({ type: "acp.session", sessionId: "ses_demo" }));
  const found = readAcpTranscript({ root, campaign: "demo", run });
  assert.equal(found.session.id, "ses_demo");
  assert.equal(readAcpTranscript({ root, campaign: "demo", run: "../escape" }), null);
});
