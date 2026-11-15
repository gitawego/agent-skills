import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTranscript, readTranscript } from "../scripts/lib/transcript.mjs";

function event(value) {
  return `${JSON.stringify(value)}\n`;
}

test("a pi session parses into roles, text and tool calls", () => {
  const text =
    event({ type: "session", id: "orch-demo-01", cwd: "/tmp/demo", version: 3, timestamp: "2026-01-01T00:00:00Z" }) +
    event({ type: "model_change", provider: "opencode-go", modelId: "deepseek-v4.1-flash" }) +
    event({ type: "thinking_level_change", thinkingLevel: "high" }) +
    event({ type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "Build it." }] } }) +
    event({ type: "message", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] } }) +
    event({ type: "message", timestamp: "2026-01-01T00:00:03Z", message: { role: "toolResult", toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "a\nb" }] } });

  const parsed = parseTranscript(text);
  assert.equal(parsed.session.id, "orch-demo-01");
  assert.equal(parsed.session.model, "deepseek-v4.1-flash");
  assert.equal(parsed.session.thinking, "high");
  assert.equal(parsed.total, 3);
  assert.equal(parsed.messages[0].role, "user");
  assert.equal(parsed.messages[1].toolCalls[0].name, "bash");
  assert.equal(parsed.messages[1].toolCalls[0].args.command, "ls");
  assert.equal(parsed.messages[2].role, "toolResult");
  assert.match(parsed.messages[2].text, /a\nb/);
});

test("a transcript keeps the tail and reports truncation", () => {
  const messages = Array.from({ length: 12 }, (_, index) =>
    event({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `message ${index}` }] } }),
  ).join("");
  const parsed = parseTranscript(messages, { maxMessages: 5 });
  assert.equal(parsed.total, 12);
  assert.equal(parsed.messages.length, 5);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.messages[0].text, /message 7/);
});

test("readTranscript resolves a pi session file and refuses a missing one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-transcript-"));
  fs.writeFileSync(
    path.join(dir, "2026-01-01T00-00-00-000Z_orch-demo-01.jsonl"),
    event({ type: "session", id: "orch-demo-01" }) +
      event({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
  );
  const found = readTranscript({ sessionsDir: dir, sessionId: "orch-demo-01" });
  assert.ok(found.file.endsWith("_orch-demo-01.jsonl"));
  assert.equal(found.messages[0].text, "hello");
  assert.equal(readTranscript({ sessionsDir: dir, sessionId: "orch-demo-02" }), null);
});
