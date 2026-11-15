// Optional embedded terminal: a PTY running a pi session, bridged to the
// browser over WebSocket. The panel must keep working when node-pty or ws is
// not installed; this module reports that state instead of failing startup.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { appendJsonl, campaignSessionsDir, exists, nowIso, projectStateDir, SKILL_DIR } from "./util.mjs";
import { loadState } from "./state.mjs";
import { sessionFileFor } from "./runs.mjs";

const MAX_BUFFER = 200_000;
const IDLE_MS = 30 * 60 * 1000;
const MAX_COLS = 400;
const MAX_ROWS = 200;

function clamp(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(max, Math.floor(number));
}

function usageTotals(file) {
  const total = { tokens: 0, dollars: 0 };
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "message") continue;
      const usage = event.message?.usage;
      if (!usage) continue;
      total.tokens += Number(usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0));
      total.dollars += Number(usage.cost?.total || 0);
    }
  } catch {
    /* a session without usage is still a session */
  }
  return total;
}

function newSessionFiles(dir, since, exclude) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl") && name !== exclude)
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try {
          return fs.statSync(file).mtimeMs >= since;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function optionalModules(root) {
  const bases = [root, process.cwd(), SKILL_DIR];
  for (const base of String(process.env.ORCH_TERMINAL_MODULES || "")
    .split(path.delimiter)
    .filter(Boolean)) {
    bases.push(base);
  }
  const load = (name) => {
    for (const base of bases) {
      try {
        return createRequire(path.join(base, "package.json"))(name);
      } catch {
        /* try the next location */
      }
    }
    return null;
  };
  const pty = load("node-pty");
  const WebSocket = load("ws");
  if (!pty || !WebSocket) {
    const missing = [!pty && "node-pty", !WebSocket && "ws"].filter(Boolean);
    return {
      error: `embedded terminal needs ${missing.join(" and ")}; install them in the project root or set ORCH_TERMINAL_MODULES`,
    };
  }
  return { pty, WebSocket };
}

export function createTerminalHub({ server, currentRoots, authorized, log = () => {} }) {
  const sessions = new Map();
  const moduleCache = new Map();
  let wss = null;

  function modulesFor(root) {
    if (!moduleCache.has(root)) moduleCache.set(root, optionalModules(root));
    return moduleCache.get(root);
  }

  function ticketInfo(root, campaign, ticketId) {
    if (!currentRoots().includes(root)) throw new Error("unknown project");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(campaign)) throw new Error("unknown campaign");
    if (!/^\d{2}$/.test(ticketId)) throw new Error("unknown ticket");
    const state = loadState(root, campaign);
    const entry = state.tickets[ticketId];
    if (!entry) throw new Error("unknown ticket");
    const run = entry.run ? state.runs[entry.run] : null;
    const workRuns = Object.values(state.runs || {}).filter((candidate) => candidate.ticket === ticketId && candidate.role === "work");
    const latest = workRuns.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || run;
    const adapter = latest?.adapter || (latest?.sessionId ? "pi" : null);
    const sessionId = entry.sessionId || latest?.sessionId || null;
    const sessionsDir = campaignSessionsDir(root, campaign);
    const sessionFile = sessionFileFor(sessionsDir, sessionId);
    const workdir = entry.workdir || latest?.workdir || root;
    return {
      root,
      campaign,
      ticket: ticketId,
      stage: entry.stage,
      owner: entry.owner || null,
      live: Boolean(run && run.status === "live"),
      adapter,
      sessionId,
      sessionFile,
      sessionsDir,
      workdir: exists(workdir) ? workdir : root,
      hasSession: Boolean(sessionFile),
    };
  }

  function status(root, campaign, ticketId) {
    try {
      const info = ticketInfo(root, campaign, ticketId);
      const modules = modulesFor(root);
      if (modules.error) return { ok: false, available: false, reason: modules.error, ...info };
      if (info.adapter && info.adapter !== "pi") {
        return { ok: false, available: false, reason: "this ticket belongs to a legacy ACP adapter; use the agent/CLI", ...info };
      }
      if (!info.sessionId) {
        return { ok: false, available: false, reason: "this ticket has no session yet", ...info };
      }
      if (!info.hasSession) {
        return { ok: false, available: false, reason: "the pi session file is missing", ...info };
      }
      return {
        ok: true,
        available: true,
        reason: null,
        mode: info.owner === "human" && !info.live ? "attach" : "fork",
        canAttach: info.owner === "human" && !info.live,
        canFork: true,
        ...info,
      };
    } catch (err) {
      return { ok: false, available: false, reason: err.message };
    }
  }

  function command(info, mode) {
    const pi = process.env.PI_BIN || "pi";
    const args =
      mode === "attach"
        ? ["--session-id", info.sessionId, "--session-dir", info.sessionsDir]
        : ["--fork", info.sessionId, "--session-dir", info.sessionsDir, "--tools", "read,grep,find,ls"];
    return { pi, args };
  }

  function open(info, mode, cols, rows) {
    const key = `${info.root}\0${info.campaign}\0${info.ticket}`;
    const existing = sessions.get(key);
    if (existing) {
      clearTimeout(existing.idle);
      existing.idle = null;
      return existing;
    }
    const modules = modulesFor(info.root);
    if (modules.error) throw new Error(modules.error);
    const { pi, args } = command(info, mode);
    const term = modules.pty.spawn(pi, args, {
      name: "xterm-256color",
      cols: clamp(cols, 100, MAX_COLS),
      rows: clamp(rows, 30, MAX_ROWS),
      cwd: info.workdir,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    const session = {
      key,
      info,
      mode,
      pty: term,
      buffer: "",
      clients: new Set(),
      idle: null,
      ended: false,
      openedAt: Date.now(),
      baseline: usageTotals(info.sessionFile),
    };
    sessions.set(key, session);
    term.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      for (const client of session.clients) {
        if (client.readyState === 1) client.send(JSON.stringify({ type: "data", data }));
      }
    });
    term.onExit((event) => {
      session.ended = true;
      clearTimeout(session.idle);
      const usage =
        mode === "attach"
          ? (() => {
              const after = usageTotals(info.sessionFile);
              return { tokens: Math.max(0, after.tokens - session.baseline.tokens), dollars: Math.max(0, after.dollars - session.baseline.dollars) };
            })()
          : (() => {
              const files = newSessionFiles(info.sessionsDir, session.openedAt, path.basename(info.sessionFile || ""));
              if (files.length > 1) {
                log(`terminal ${info.campaign}/${info.ticket}: ${files.length} fork session files; usage not attributed`);
                return { tokens: 0, dollars: 0 };
              }
              return files.length ? usageTotals(files[0]) : { tokens: 0, dollars: 0 };
            })();
      if (usage.tokens || usage.dollars) {
        appendJsonl(path.join(projectStateDir(info.root), "campaigns", info.campaign, "human-sessions.jsonl"), {
          ticket: info.ticket,
          sessionId: info.sessionId,
          mode,
          tokens: usage.tokens,
          dollars: usage.dollars,
          at: nowIso(),
          source: "terminal",
        });
      }
      for (const client of session.clients) {
        if (client.readyState === 1) client.send(JSON.stringify({ type: "exit", code: event.exitCode, signal: event.signal }));
        try {
          client.close();
        } catch {
          /* already closed */
        }
      }
      sessions.delete(key);
      log(`terminal ${info.campaign}/${info.ticket} exited (${event.exitCode})`);
    });
    log(`terminal ${info.campaign}/${info.ticket} opened in ${mode} at ${info.workdir}`);
    return session;
  }

  function attach(session, ws) {
    session.clients.add(ws);
    clearTimeout(session.idle);
    session.idle = null;
    ws.send(JSON.stringify({ type: "ready", mode: session.mode, buffer: session.buffer }));
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.type === "input" && typeof message.data === "string") session.pty.write(message.data);
      if (message.type === "resize") {
        session.pty.resize(clamp(message.cols, 100, MAX_COLS), clamp(message.rows, 30, MAX_ROWS));
      }
      if (message.type === "terminate") {
        try {
          session.pty.kill();
        } catch {
          /* gone */
        }
      }
      if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
    ws.on("close", (code, reason) => {
      session.clients.delete(ws);
      if (String(reason) === "terminate") {
        try {
          session.pty.kill();
        } catch {
          /* gone */
        }
        return;
      }
      if (!session.clients.size && !session.ended) {
        session.idle = setTimeout(() => {
          try {
            session.pty.kill();
          } catch {
            /* gone */
          }
        }, IDLE_MS);
        session.idle.unref?.();
      }
    });
  }

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/api/terminal") return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) throw new Error("origin mismatch");
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return true;
      }
    }
    if (!authorized(req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return true;
    }
    const root = url.searchParams.get("project");
    const campaign = String(url.searchParams.get("campaign") || "");
    const ticket = String(url.searchParams.get("ticket") || "");
    const requested = url.searchParams.get("mode") === "attach" ? "attach" : "fork";
    const info = status(root, campaign, ticket);
    if (!info.available) {
      socket.write(`HTTP/1.1 409 Conflict\r\nContent-Type: text/plain\r\n\r\n${info.reason || "terminal unavailable"}`);
      socket.destroy();
      return true;
    }
    if (requested === "attach" && !info.canAttach) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\nstop the run and take over before attaching");
      socket.destroy();
      return true;
    }
    const mode = requested === "attach" ? "attach" : "fork";
    if (!wss) {
      const modules = modulesFor(root);
      if (modules.error) {
        socket.write(`HTTP/1.1 501 Not Implemented\r\n\r\n${modules.error}`);
        socket.destroy();
        return true;
      }
      wss = new modules.WebSocket.WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        const term = open(info, mode, url.searchParams.get("cols"), url.searchParams.get("rows"));
        attach(term, ws);
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", error: err.message }));
        ws.close();
      }
    });
    return true;
  }

  server.on("upgrade", (req, socket, head) => {
    if (!handleUpgrade(req, socket, head)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  return {
    status,
    close() {
      for (const session of sessions.values()) {
        clearTimeout(session.idle);
        try {
          session.pty.kill();
        } catch {
          /* gone */
        }
      }
      sessions.clear();
      wss?.close();
    },
  };
}
