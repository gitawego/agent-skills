// The panel server: loopback only, SSE, and a command queue. No dependencies.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { SKILL_DIR, consoleStateDir, ensureDir, globalPanelFile, nowIso, projectStateDir, readJson, registryFile, writeJson } from "./util.mjs";
import { projectView, consoleView } from "./view.mjs";
import { adaptersView, allModels, catalogsForRoot } from "./catalogs.mjs";
import { enqueue } from "./commands.mjs";
import { loadDispatch } from "./dispatch.mjs";

const UI = path.join(SKILL_DIR, "assets", "ui");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function startServer({ roots = [], getRoots = null, port = 4173, bind = "127.0.0.1", token, onCommand, log = () => {} }) {
  /* the registry can grow while the panel runs, so read it per request */
  const extraRoots = new Set();
  const currentRoots = () => [...new Set([...(getRoots ? getRoots() : roots), ...extraRoots])];
  const secret = token || randomBytes(12).toString("hex");
  const clients = new Set();
  const recent = [];
  let nextId = 1;
  const offsets = new Map();

  function record(event, projectRoot, seq) {
    const id = nextId++;
    const payload = { id, seq, project: projectRoot, event };
    recent.push(payload);
    if (recent.length > 1000) recent.shift();
    for (const client of clients) {
      client.write(`id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  }

  function poll() {
    for (const root of currentRoots()) {
      const file = path.join(projectStateDir(root), "events.jsonl");
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n").filter(Boolean);
      const seen = offsets.get(root) || 0;
      if (lines.length < seen) offsets.set(root, lines.length);
      for (let i = seen; i < lines.length; i++) {
        try {
          record(JSON.parse(lines[i]), root, i);
        } catch {
          // ignore a half-written line
        }
      }
      offsets.set(root, lines.length);
    }
  }

  const timer = setInterval(poll, 1000);
  timer.unref?.();

  function cookies(req) {
    return Object.fromEntries(
      String(req.headers.cookie || "")
        .split(";")
        .map((part) => part.trim().split("="))
        .filter((pair) => pair.length === 2),
    );
  }

  function tokenFrom(req, url) {
    return req.headers["x-orch-token"] || url.searchParams.get("token") || cookies(req).orch_token || "";
  }

  function authorized(req, url) {
    if (req.socket.remoteAddress && !/^(127\.|::1|::ffff:127\.)/.test(req.socket.remoteAddress)) return false;
    return tokenFrom(req, url) === secret;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const route = url.pathname;

    if (route !== "/" && route !== "/index.html" && !route.startsWith("/api/")) {
      const relative = path.normalize(route.replace(/^\//, ""));
      const file = path.join(UI, relative);
      if (!file.startsWith(UI + path.sep)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          "content-type": MIME[path.extname(file)] || "application/octet-stream",
          "cache-control": path.extname(file) === ".woff2" ? "max-age=86400" : "no-store",
        });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
      return;
    }

    if (!authorized(req, url)) {
      json(res, 401, { error: "missing or wrong token" });
      return;
    }

    if (route === "/" || route === "/index.html") {
      try {
        const body = fs.readFileSync(path.join(UI, "index.html"));
        const headers = { "content-type": MIME[".html"], "cache-control": "no-store" };
        /* the page is served with a cookie so a refresh, a new tab or a bookmark
           keeps working without the token in the address bar */
        if (tokenFrom(req, url) === secret) {
          headers["set-cookie"] = `orch_token=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
        }
        res.writeHead(200, headers);
        res.end(body);
      } catch {
        res.writeHead(500).end("the panel assets are missing");
      }
      return;
    }

    if (route === "/api/state") {
      const projects = currentRoots().map((root) => {
        try {
          return projectView(root);
        } catch (err) {
          return { root, name: path.basename(root), error: err.message, campaigns: [] };
        }
      });
      let models = [];
      try {
        models = allModels().map((row) => ({ ...row }));
      } catch {
        models = [];
      }
      json(res, 200, {
        ok: true,
        now: new Date().toISOString(),
        projects,
        console: consoleView().config,
        dispatch: loadDispatch(),
        adapters: adaptersView(),
        catalogs: Object.fromEntries(projects.map((project) => [project.root, catalogsForRoot(project.root)])),
        catalog: models,
      });
      return;
    }

    if (route === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      const lastId = Number(url.searchParams.get("lastId") || req.headers["last-event-id"] || 0);
      const replay = lastId ? recent.filter((item) => item.id > lastId) : recent.slice(-40);
      for (const item of replay) {
        res.write(`id: ${item.id}\ndata: ${JSON.stringify(item)}\n\n`);
      }
      clients.add(res);
      const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(beat);
        clients.delete(res);
      });
      return;
    }

    if (route === "/api/log") {
      const root = url.searchParams.get("project");
      const run = url.searchParams.get("run");
      const offset = Number(url.searchParams.get("offset") || 0);
      if (!currentRoots().includes(root) || !run) {
        json(res, 400, { error: "unknown project or run" });
        return;
      }
      const file = path.join(projectStateDir(root), "campaigns", url.searchParams.get("campaign") || "", "runs", run, "log.jsonl");
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        text = "";
      }
      const start = Math.min(offset, text.length);
      const chunk = text.slice(start, start + 200_000);
      json(res, 200, { text: chunk, offset: start + chunk.length, size: text.length });
      return;
    }

    if (route === "/api/browse") {
      try {
        const dir = path.resolve(url.searchParams.get("path") || os.homedir());
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) throw new Error("not a directory");
        const entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 500);
        json(res, 200, {
          ok: true,
          path: dir,
          parent: path.dirname(dir) === dir ? null : path.dirname(dir),
          entries,
        });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    if (route === "/api/projects" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const root = path.resolve(String(body.root || "").trim());
        if (!root || !fs.statSync(root).isDirectory()) throw new Error("path is not a directory");
        extraRoots.add(root);
        const file = registryFile();
        const registry = readJson(file, { version: 1, projects: [] });
        const projects = (registry.projects || []).filter((project) => project.path !== root);
        projects.push({ path: root, name: path.basename(root), registeredAt: nowIso() });
        writeJson(file, { version: 1, projects });
        json(res, 200, { ok: true, root });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    if (route === "/api/attachments" && req.method === "POST") {
      try {
        const body = await readBody(req, 30_000_000);
        if (!currentRoots().includes(body.root)) throw new Error("unknown project");
        if (!/^[a-z0-9][a-z0-9-]*$/.test(String(body.campaign || ""))) throw new Error("unknown campaign");
        const ext = path.extname(String(body.name || "")).toLowerCase();
        const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf" }[ext];
        if (!mime) throw new Error("only png, jpeg, webp, gif or pdf attachments are supported");
        const raw = String(body.data || "").replace(/^data:[^;]+;base64,/, "");
        const bytes = Buffer.from(raw, "base64");
        if (!bytes.length) throw new Error("empty image");
        const limit = ext === ".pdf" ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
        if (bytes.length > limit) throw new Error(`attachment is larger than ${Math.floor(limit / 1024 / 1024)} MB`);
        const dir = path.join(body.root, "orchestration", body.campaign, "attachments");
        fs.mkdirSync(dir, { recursive: true });
        const base = path.basename(String(body.name)).replace(/[^A-Za-z0-9._-]/g, "-").slice(-80) || `image${ext}`;
        let name = base;
        if (fs.existsSync(path.join(dir, name))) name = `${Date.now()}-${base}`;
        fs.writeFileSync(path.join(dir, name), bytes);
        json(res, 200, {
          ok: true,
          path: path.relative(body.root, path.join(dir, name)).split(path.sep).join("/"),
          mimeType: mime,
          bytes: bytes.length,
        });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    if (route === "/api/commands" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const root = body.root;
        if (!currentRoots().includes(root)) {
          json(res, 400, { error: "unknown project" });
          return;
        }
        const command = { ...body };
        delete command.root;
        if (!command.type) throw new Error("command has no type");
        enqueue(root, command);
        if (onCommand) onCommand();
        json(res, 200, { ok: true, queued: command.type });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    json(res, 404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const listen = () => {
      const onError = (err) => {
        if (err.code === "EADDRINUSE" && attempt < 20) {
          attempt++;
          listen();
          return;
        }
        reject(err);
      };
      server.once("error", onError);
      server.listen(port + attempt, bind, () => {
        server.removeListener("error", onError);
        const actual = server.address().port;
        const info = {
          url: `http://${bind}:${actual}/?token=${secret}`,
          port: actual,
          token: secret,
          pid: process.pid,
          roots: currentRoots(),
          startedAt: new Date().toISOString(),
        };
        ensureDir(consoleStateDir());
        fs.writeFileSync(globalPanelFile(), JSON.stringify(info, null, 2));
        for (const root of currentRoots()) {
          ensureDir(projectStateDir(root));
          fs.writeFileSync(path.join(projectStateDir(root), "panel.json"), JSON.stringify(info, null, 2));
        }
        log(`panel: http://${bind}:${actual}/?token=${secret}`);
        resolve({
          server,
          port: actual,
          token: secret,
          url: `http://${bind}:${actual}/?token=${secret}`,
          close: () => {
            clearInterval(timer);
            for (const client of clients) client.end();
            server.close();
            try {
              const current = JSON.parse(fs.readFileSync(globalPanelFile(), "utf8"));
              if (current.pid === process.pid) fs.unlinkSync(globalPanelFile());
            } catch {
              /* already gone */
            }
          },
        });
      });
    };
    listen();
  });
}
