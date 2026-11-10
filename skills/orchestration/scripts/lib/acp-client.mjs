// Minimal ACP (Agent Client Protocol) client: JSON-RPC 2.0 over ndjson stdio.
import { spawn } from "node:child_process";
import readline from "node:readline";

export function connect({ command, args = [], cwd, env = {}, onNotification, onStderr, autoApprove = true, onPermission = null }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.method) {
      if (msg.id != null) {
        // Server -> client request. Only permissions matter for a worker.
        if (msg.method === "session/request_permission") {
          const options = msg.params?.options || [];
          let option = null;
          if (onPermission) {
            const chosen = onPermission(msg);
            option = options.find((o) => o.optionId === chosen) || null;
          } else if (autoApprove) {
            option = options.find((o) => /allow/i.test(`${o.optionId} ${o.name}`)) || options[0];
          }
          if (option) {
            send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } });
          } else {
            send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
          }
          return;
        }
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `client method not supported: ${msg.method}` },
        });
        return;
      }
      if (onNotification) onNotification(msg);
      for (const listener of listeners) listener(msg);
      return;
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  });
  if (onStderr) child.stderr.on("data", (d) => onStderr(d.toString()));
  child.on("exit", () => {
    for (const [, waiter] of pending) waiter({ error: { code: -32000, message: "agent exited" } });
    pending.clear();
  });

  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  function request(method, params, timeoutMs = 120_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method, params) {
    send({ jsonrpc: "2.0", method, params });
  }

  async function close() {
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function onNotificationListener(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { child, request, notify, close, onNotification: onNotificationListener };
}

export async function initialize(client, { name = "orchestration", version = "1" } = {}) {
  return client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name, version },
  });
}
