import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { sandbox, project, writeConsole, writeCampaign, writeTicket, commitAll, MODELS } from "./helpers.mjs";
import { startServer } from "../scripts/lib/server.mjs";
import { loadState, saveState } from "../scripts/lib/state.mjs";

const BODY = `## Goal\n\nTerminal.\n\n## Brief\n\nB.\n\n## Acceptance criteria\n\n- [ ] Shown.\n\n## Constraints\n\nC.\n\n## What to read first\n\n- **Files:** README.md\n`;

function optionalDeps() {
  const bases = String(process.env.ORCH_TERMINAL_MODULES || "").split(path.delimiter).filter(Boolean);
  for (const base of bases) {
    try {
      const req = createRequire(path.join(base, "package.json"));
      req("node-pty");
      req("ws");
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

test("the terminal bridge opens a PTY, echoes input, and terminates", { skip: !optionalDeps() }, async () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  writeCampaign(
    dir,
    "demo",
    {
      campaign: "demo",
      stage: "running",
      autonomy: "supervised",
      plan_gate: "human",
      landing: "branch",
      base: "main",
      checks: [],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] } },
    },
    BODY,
  );
  writeTicket(
    dir,
    "demo",
    "01-work.md",
    { id: "01", kind: "code", touches: ["src/**"] },
    "## What to build\n\nIt.\n\n## Acceptance criteria\n\n- [ ] Works.",
  );
  commitAll(dir);
  const state = loadState(dir, "demo");
  state.tickets["01"] = { stage: "working", attempts: 0, gateCycles: 0, run: null, sessionId: "orch-demo-01", workdir: dir, steers: [] };
  saveState(dir, "demo", state);
  const sessionsDir = path.join(dir, ".orchestration", "campaigns", "demo", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "2026-01-01T00-00-00-000Z_orch-demo-01.jsonl"), `${JSON.stringify({ type: "session", id: "orch-demo-01", cwd: dir })}\n`);

  const fake = path.join(box, "fake-terminal.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write("fake terminal ready\\n");\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (data) => process.stdout.write("echo:" + data));\nsetInterval(() => {}, 1000);\n`);
  fs.chmodSync(fake, 0o755);
  const previous = process.env.PI_BIN;
  process.env.PI_BIN = fake;
  const panel = await startServer({ roots: [dir], port: 0 });
  try {
    const status = await (await fetch(`http://127.0.0.1:${panel.port}/api/terminal/status?project=${encodeURIComponent(dir)}&campaign=demo&ticket=01&token=${panel.token}`)).json();
    assert.equal(status.available, true);
    assert.equal(status.canFork, true);

    const ws = new WebSocket(`ws://127.0.0.1:${panel.port}/api/terminal?project=${encodeURIComponent(dir)}&campaign=demo&ticket=01&mode=fork&cols=100&rows=30&token=${panel.token}`);
    const messages = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("terminal did not start")), 5000);
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        messages.push(message);
        if (message.type === "ready") {
          ws.send(JSON.stringify({ type: "input", data: "hello\r" }));
        }
        if (message.type === "data" && messages.some((item) => item.type === "data" && item.data.includes("echo:hello"))) {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onerror = () => reject(new Error("terminal websocket failed"));
    });
    assert.ok(messages.some((message) => message.type === "ready"));
    assert.ok(messages.some((message) => message.type === "data" && message.data.includes("fake terminal ready")));
    ws.send(JSON.stringify({ type: "terminate" }));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      ws.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    ws.close();
  } finally {
    panel.close();
    if (previous == null) delete process.env.PI_BIN;
    else process.env.PI_BIN = previous;
  }
});
