// Paths, files, and small helpers. Standard library only.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const SKILL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
export const REPORT_SCRIPT = path.join(SKILL_DIR, "scripts", "report.mjs");

export function home() {
  return process.env.HOME || os.homedir();
}

export function configHome() {
  return process.env.XDG_CONFIG_HOME || path.join(home(), ".config");
}

export function stateHome() {
  return process.env.XDG_STATE_HOME || path.join(home(), ".local", "state");
}

export const consoleDir = () => path.join(configHome(), "orchestration");
export const consoleFile = () => path.join(consoleDir(), "console.json");
export const consoleStateDir = () => path.join(stateHome(), "orchestration");
export const globalPanelFile = () => path.join(consoleStateDir(), "panel.json");
export const binHome = () => process.env.XDG_BIN_HOME || path.join(home(), ".local", "bin");
export const dataHome = () => process.env.XDG_DATA_HOME || path.join(home(), ".local", "share");

/* A stable panel token: rotate it by deleting the file. 0600, loopback only. */
export function panelToken() {
  const file = path.join(consoleStateDir(), "token");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const token = randomBytes(16).toString("hex");
  ensureDir(consoleStateDir());
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}
export const registryFile = () => path.join(consoleStateDir(), "registry.json");

export const projectStateDir = (root) => path.join(root, ".orchestration");
export const campaignPlanDir = (root, slug) => path.join(root, "orchestration", slug);
export const campaignStateDir = (root, slug) => path.join(projectStateDir(root), "campaigns", slug);
export const campaignStateFile = (root, slug) => path.join(campaignStateDir(root, slug), "state.json");
export const campaignEventsFile = (root) => path.join(projectStateDir(root), "events.jsonl");
export const campaignRunsDir = (root, slug) => path.join(campaignStateDir(root, slug), "runs");
export const campaignInboxDir = (root, slug) => path.join(campaignStateDir(root, slug), "inbox");
export const campaignWorktreesDir = (root, slug) => path.join(campaignStateDir(root, slug), "worktrees");
export const campaignSessionsDir = (root, slug) => path.join(campaignStateDir(root, slug), "sessions");
export const campaignDecisionsFile = (root, slug) => path.join(campaignStateDir(root, slug), "decisions.jsonl");
export const commandsFile = (root) => path.join(projectStateDir(root), "commands.jsonl");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}

export function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readText(file, fallback = null) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

/* Prompt and packet fields are bounded. The pointer stays visible when the
   body is cut, so a reader can fetch the rest instead of guessing. */
export function clip(value, max = 1200, label = "truncated") {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  if (max <= 0) return `… [${label}]`;
  const cut = text.slice(0, max);
  const line = cut.lastIndexOf("\n");
  const body = line > max * 0.6 ? cut.slice(0, line) : cut;
  return `${body}… [${label}; ${text.length} chars]`;
}

export function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

export function slugify(input) {
  return String(input)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "campaign";
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function stamp() {
  return nowIso().replace(/[-:]/g, "").replace("T", "T").replace("Z", "");
}

export function pad2(value) {
  const s = String(value).trim();
  return /^\d$/.test(s) ? `0${s}` : s;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function truncate(text, max = 2000) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

export function tail(text, lines = 40) {
  const all = String(text ?? "").split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

export function git(cwd, args, opts = {}) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: opts.timeout ?? 60_000,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

export function isGitRepo(dir) {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function relative(root, file) {
  return path.relative(root, file) || ".";
}

export class UserError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.name = "UserError";
    this.hints = hints;
  }
}
