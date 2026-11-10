import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, project } from "./helpers.mjs";
import { loadAttachments, attachmentPaths, attachmentAudit } from "../scripts/lib/attachments.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function fixture() {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  fs.mkdirSync(path.join(dir, "refs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "refs", "red.png"), PNG);
  return dir;
}

test("an image is read, typed and hashed", () => {
  const dir = fixture();
  const { items, errors } = loadAttachments(dir, ["refs/red.png"]);
  assert.deepEqual(errors, []);
  assert.equal(items.length, 1);
  assert.equal(items[0].mimeType, "image/png");
  assert.equal(items[0].path, "refs/red.png");
  assert.equal(items[0].bytes, PNG.length);
  assert.match(items[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(items[0].data, "base64").length, PNG.length);
  assert.deepEqual(attachmentAudit(items), [
    { path: "refs/red.png", mimeType: "image/png", bytes: PNG.length, sha256: items[0].sha256 },
  ]);
});

test("missing, outside and unsupported attachments are refused", () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an image");
  const { errors } = loadAttachments(dir, ["refs/nope.png", "../escape.png", "notes.txt"]);
  assert.ok(errors.some((e) => /does not exist/.test(e)));
  assert.ok(errors.some((e) => /outside the project/.test(e)));
  assert.ok(errors.some((e) => /not a supported image/.test(e)));
});

test("attachmentPaths accepts a string or a list", () => {
  assert.deepEqual(attachmentPaths({ data: { attachments: "refs/a.png" } }), ["refs/a.png"]);
  assert.deepEqual(attachmentPaths({ attachments: ["a.png", "b.png"] }), ["a.png", "b.png"]);
  assert.deepEqual(attachmentPaths({ data: {} }), []);
});
