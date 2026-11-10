#!/usr/bin/env node
// A tiny ACP agent for contract tests: ndjson JSON-RPC on stdio.
import fs from "node:fs";
import readline from "node:readline";

let session = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  const msg = JSON.parse(text);
  if (!msg.method) return;
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  const error = (message) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message } }) + "\n");

  if (msg.method === "initialize") {
    send({
      protocolVersion: 1,
      agentInfo: { name: "Fake ACP", version: "1" },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { resume: {}, load: {}, close: {}, list: {} },
      },
      authMethods: [],
    });
    return;
  }
  if (msg.method === "session/new") {
    session = `ses_${Math.random().toString(16).slice(2)}`;
    send({
      sessionId: session,
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "fake/cheap",
          options: [
            { value: "fake/cheap", name: "Fake Cheap" },
            { value: "fake/vision", name: "Fake Vision" },
          ],
        },
        { id: "thought_level", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
        { id: "mode", category: "mode", type: "select", currentValue: "auto", options: [{ value: "auto" }, { value: "plan" }] },
      ],
    });
    return;
  }
  if (msg.method === "session/set_config_option") {
    const options = [
      { id: "model", category: "model", type: "select", currentValue: "fake/cheap", options: [{ value: "fake/cheap" }, { value: "fake/vision" }] },
      { id: "thought_level", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
      { id: "mode", category: "mode", type: "select", currentValue: "auto", options: [{ value: "auto" }, { value: "plan" }] },
    ];
    const found = options.find((o) => o.id === msg.params.configId);
    if (found && found.options.some((o) => o.value === msg.params.value)) found.currentValue = msg.params.value;
    send({ configOptions: options });
    return;
  }
  if (msg.method === "session/prompt") {
    const blocks = msg.params.prompt || [];
    const images = blocks.filter((b) => b.type === "image");
    const report = process.env.FAKE_ACP_REPORT;
    if (report) {
      fs.writeFileSync(report, JSON.stringify({ status: "ready", summary: `saw ${images.length} images` }));
    }
    send({
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
    });
    return;
  }
  if (msg.method === "session/load" || msg.method === "session/resume") {
    send({ sessionId: msg.params.sessionId, configOptions: [] });
    return;
  }
  if (msg.method === "session/close") {
    send({});
    return;
  }
  error(`unsupported method ${msg.method}`);
});
