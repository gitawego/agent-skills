#!/usr/bin/env node
// A tiny ACP agent that asks for permission before answering a prompt.
import readline from "node:readline";

let nextId = 1;
let session = null;
let permissionReply = null;
const rl = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  const msg = JSON.parse(text);
  if (!msg.method) {
    if (permissionReply) {
      const reply = permissionReply;
      permissionReply = null;
      reply(msg);
    }
    return;
  }
  if (msg.method === "initialize") {
    send(msg.id, { protocolVersion: 1, agentInfo: { name: "Fake Permission", version: "1" }, agentCapabilities: {} });
    return;
  }
  if (msg.method === "session/new") {
    session = `ses_${Math.random().toString(16).slice(2)}`;
    send(msg.id, { sessionId: session, configOptions: [] });
    return;
  }
  if (msg.method === "session/prompt") {
    const id = nextId++;
    const reply = await new Promise((resolve) => {
      permissionReply = resolve;
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "session/request_permission",
          params: {
            sessionId: session,
            toolCall: { title: "Write file", kind: "edit", locations: [{ path: "hello.txt" }] },
            options: [
              { optionId: "allow", name: "Allow" },
              { optionId: "deny", name: "Deny" },
            ],
          },
        }) + "\n",
      );
    });
    const selected = reply.result?.outcome?.optionId || "cancelled";
    send(msg.id, { stopReason: selected === "allow" ? "end_turn" : "cancelled", usage: { totalTokens: 0 } });
    return;
  }
  if (msg.method === "session/close") {
    send(msg.id, {});
    return;
  }
  send(msg.id, {});
});
