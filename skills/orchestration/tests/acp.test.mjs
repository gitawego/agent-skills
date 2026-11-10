import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, initialize } from "../scripts/lib/acp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fixtures", "fake-acp.mjs");
fs.chmodSync(FAKE, 0o755);

test("the ACP client initializes, configures and prompts a session", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-acp-test-"));
  const client = connect({ command: process.execPath, args: [FAKE], cwd });
  try {
    const init = await initialize(client, { name: "test", version: "1" });
    assert.equal(init.agentInfo.name, "Fake ACP");
    assert.equal(init.agentCapabilities.promptCapabilities.image, true);

    const session = await client.request("session/new", { cwd, mcpServers: [] });
    assert.match(session.sessionId, /^ses_/);
    assert.equal(session.configOptions.find((o) => o.id === "model").currentValue, "fake/cheap");

    const changed = await client.request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: "model",
      value: "fake/vision",
    });
    assert.equal(changed.configOptions.find((o) => o.id === "model").currentValue, "fake/vision");

    const result = await client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [
        { type: "text", text: "describe" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.usage.totalTokens, 105);

    await client.request("session/close", { sessionId: session.sessionId });
  } finally {
    await client.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
