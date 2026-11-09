// Test scaffolding: a disposable project, a disposable console, a fake worker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
export const SKILL = path.resolve(FIXTURES, "..");

export const FAKE_WORKER = path.join(FIXTURES, "fixtures", "fake-worker.mjs");
export const FAKE_CATALOG = path.join(FIXTURES, "fixtures", "fake-catalog.sh");

fs.chmodSync(FAKE_CATALOG, 0o755);
fs.chmodSync(FAKE_WORKER, 0o755);

export const MODELS = {
  fast: "test/model-fast",
  strong: "test/model-strong",
  backup: "other/model-backup",
};

export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  process.env.XDG_STATE_HOME = path.join(dir, "state");
  process.env.XDG_BIN_HOME = path.join(dir, "bin");
  process.env.XDG_DATA_HOME = path.join(dir, "share");
  process.env.PI_BIN = FAKE_CATALOG;
  process.env.FAKE_SCENARIO = path.join(dir, "scenario.json");
  fs.mkdirSync(path.join(dir, "repo"));
  fs.writeFileSync(process.env.FAKE_SCENARIO, JSON.stringify({ work: [], review: [], judge: [], merge: [] }));
  return dir;
}

export function scenario(value) {
  fs.writeFileSync(process.env.FAKE_SCENARIO, JSON.stringify(value, null, 2));
}

export function project(dir, { git = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".orchestration/\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# test project\n");
  if (git) {
    const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    run(["init", "-q", "-b", "main"]);
    run(["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"]);
    run(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"]);
  }
  return dir;
}

export function writeConsole(overrides = {}) {
  const { unbound = false, ...rest } = overrides;
  const dir = path.join(process.env.XDG_CONFIG_HOME, "orchestration");
  fs.mkdirSync(dir, { recursive: true });
  const models = {
    plan: [{ model: MODELS.strong, thinking: "high" }],
    code: [{ model: MODELS.strong, thinking: "high" }],
    design: [{ model: MODELS.strong, thinking: "high" }],
    visual: [{ model: MODELS.strong, thinking: "high" }],
    research: [{ model: MODELS.fast, thinking: "medium" }],
    review: [{ model: MODELS.backup, thinking: "high" }],
    chores: [{ model: MODELS.fast, thinking: "low" }],
  };
  if (unbound) for (const key of Object.keys(models)) models[key] = [];
  const config = {
    version: 1,
    panel: { port: 4273, bind: "127.0.0.1" },
    limits: {
      max_concurrent: 4,
      run_timeout_min: 30,
      stuck_after_min: 0,
      max_attempts: 3,
      human_slot_extra: 1,
    },
    kinds: Object.fromEntries(
      Object.entries(models).map(([id, chain]) => [
        id,
        { label: id, description: id, models: chain, max_concurrent: 2, tools: "default", timeout_min: 20 },
      ]),
    ),
    runner: { command: FAKE_WORKER },
    ...rest,
  };
  fs.writeFileSync(path.join(dir, "console.json"), JSON.stringify(config, null, 2));
  return config;
}

export function writeCampaign(dir, slug, data, body) {
  const campaignDir = path.join(dir, "orchestration", slug);
  fs.mkdirSync(path.join(campaignDir, "tickets"), { recursive: true });
  const header = Object.entries(data)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  fs.writeFileSync(path.join(campaignDir, "campaign.md"), `---\n${header}\n---\n\n${body}\n`);
  return campaignDir;
}

export function commitAll(dir, message = "plan") {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", message], {
    cwd: dir,
    stdio: "pipe",
  });
}

export function writeTicket(dir, slug, filename, frontmatter, body) {
  const file = path.join(dir, "orchestration", slug, "tickets", filename);
  const header = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  fs.writeFileSync(file, `---\n${header}\n---\n\n${body}\n`);
  return file;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function gitOut(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}
