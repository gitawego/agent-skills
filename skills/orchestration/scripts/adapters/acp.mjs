// Shared ACP adapter: catalog discovery + launch specification.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { profile, modelConfigValue } from "../lib/acp-profiles.mjs";
import { readText, writeJson } from "../lib/util.mjs";
import { prepareForPrompt } from "../lib/attachments.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CATALOG = path.join(HERE, "..", "acp-catalog.mjs");
const RUNNER = path.join(HERE, "..", "acp-run.mjs");

export function createAcpAdapter(adapterId) {
  const p = profile(adapterId);
  let versionCache = null;
  return {
    id: adapterId,
    label: p.label,
    capabilities() {
      return {
        systemPrompt: p.systemPrompt === "meta" ? "acp-meta" : p.systemPrompt === "agent-config" ? "acp-agent-config" : "prompt-prefix",
        tools: "native",
        thinking: "config",
        resume: "session",
        usage: "acp-usage",
        streaming: true,
        billing: p.billing,
      };
    },
    version() {
      if (versionCache) return versionCache;
      const res = spawnSync(p.command, ["--version"], { encoding: "utf8", timeout: 15_000 });
      versionCache = res.status === 0 ? (res.stdout || "").trim().split("\n")[0] : null;
      return versionCache;
    },
    listModels({ cwd } = {}) {
      const args = [CATALOG, adapterId];
      if (cwd) args.push(cwd);
      const res = spawnSync(process.execPath, args, {
        encoding: "utf8",
        timeout: 90_000,
      });
      if (res.status !== 0) {
        const err = new Error(`adapter "${adapterId}" could not discover models`);
        err.hint = (res.stderr || res.stdout || "no output").trim();
        throw err;
      }
      const rows = JSON.parse(res.stdout);
      if (!Array.isArray(rows) || !rows.length) throw new Error(`adapter "${adapterId}" advertised no models`);
      return rows;
    },
    buildLaunch({ run, modelEntry, thinking, prompt, systemPrompts, attachments = [], runDir, workdir, sandbox }) {
      const systemText = systemPrompts.map((file) => readText(file, "")).join("\n\n");
      const spec = {
        adapter: adapterId,
        cwd: workdir,
        provider: modelEntry.provider,
        model: modelEntry.model,
        modelConfigValue: modelConfigValue(p, modelEntry.provider, modelEntry.model),
        thinking,
        mode: p.mode,
        systemPrompt: systemText,
        promptMode: p.systemPrompt,
        prompt,
        images: attachments
          .filter((item) => item.kind === "image")
          .map((item) => {
            const prepared = prepareForPrompt(item);
            return { path: prepared.path, mimeType: prepared.mimeType, data: prepared.data };
          }),
        documents: attachments
          .filter((item) => item.kind === "document")
          .map((item) => ({ path: item.path, mimeType: item.mimeType, data: item.data })),
        sandbox: sandbox || "auto",
        sessionId: run.sessionId || null,
        logFile: path.join(runDir, "log.jsonl"),
        sessionFile: path.join(runDir, "session.json"),
        permissionLog: path.join(runDir, "permissions.jsonl"),
        nonce: randomUUID(),
      };
      const file = path.join(runDir, "acp-spec.json");
      writeJson(file, spec);
      return { command: process.execPath, argv: [RUNNER, file], env: {} };
    },
  };
}
