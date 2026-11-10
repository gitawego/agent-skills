import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bwrapAvailable, sandboxMode, wrapCommand } from "../scripts/lib/sandbox.mjs";

test("sandbox none leaves the command untouched", () => {
  const wrapped = wrapCommand({ command: "pi", args: ["--version"], cwd: "/tmp", mode: "none" });
  assert.equal(wrapped.command, "pi");
  assert.deepEqual(wrapped.args, ["--version"]);
});

test("bwrap wraps the command read-only with writable roots", { skip: !bwrapAvailable() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sandbox-"));
  try {
    const wrapped = wrapCommand({ command: "pi", args: ["--version"], cwd: dir, mode: "bwrap" });
    assert.equal(wrapped.command, "bwrap");
    assert.ok(wrapped.args.includes("--ro-bind"));
    assert.ok(wrapped.args.includes(dir));
    assert.deepEqual(wrapped.args.slice(-2), ["pi", "--version"]);
    assert.equal(sandboxMode("auto"), "bwrap");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
