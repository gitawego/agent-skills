// Image attachments for a ticket: read, validate, and encode for a harness.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function imageMime(file) {
  return TYPES[path.extname(String(file)).toLowerCase()] || null;
}

export function attachmentPaths(ticket) {
  const value = ticket?.data?.attachments ?? ticket?.attachments;
  if (value == null || value === "") return [];
  return (Array.isArray(value) ? value : [value]).map((p) => String(p).trim()).filter(Boolean);
}

/* Returns { items, errors }. Items carry base64 `data`; the run record only
   keeps the audit fields, never the payload. */
export function loadAttachments(root, paths) {
  const items = [];
  const errors = [];
  let total = 0;
  for (const rel of paths) {
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
      errors.push(`attachment "${rel}" is outside the project`);
      continue;
    }
    const mimeType = imageMime(abs);
    if (!mimeType) {
      errors.push(`attachment "${rel}" is not a supported image (png, jpeg, webp, gif)`);
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      errors.push(`attachment "${rel}" does not exist`);
      continue;
    }
    if (!stat.isFile()) {
      errors.push(`attachment "${rel}" is not a file`);
      continue;
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      errors.push(`attachment "${rel}" is larger than ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB`);
      continue;
    }
    total += stat.size;
    if (total > MAX_TOTAL_BYTES) {
      errors.push(`attachments exceed ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)} MB in total`);
      break;
    }
    const bytes = fs.readFileSync(abs);
    items.push({
      path: inside.split(path.sep).join("/"),
      absPath: abs,
      mimeType,
      bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      data: bytes.toString("base64"),
    });
  }
  return { items, errors };
}

export function attachmentAudit(items) {
  return items.map(({ path: file, mimeType, bytes, sha256 }) => ({ path: file, mimeType, bytes, sha256 }));
}

let imageMagick;

export function hasImageMagick() {
  if (imageMagick != null) return imageMagick;
  for (const command of ["magick", "convert"]) {
    const res = spawnSync(command, ["-version"], { encoding: "utf8", timeout: 5000 });
    if (res.status === 0) {
      imageMagick = command;
      return imageMagick;
    }
  }
  imageMagick = false;
  return false;
}

/* Large screenshots are downscaled to a bounded long edge before they cross
   the JSON-RPC pipe. This is best-effort: no ImageMagick means send original. */
export function prepareForPrompt(item, { maxEdge = 1600, maxBytes = 512 * 1024 } = {}) {
  if (item.bytes <= maxBytes) return item;
  const command = hasImageMagick();
  if (!command) return item;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-image-"));
  const source = path.join(dir, "source");
  const target = path.join(dir, "prepared.webp");
  try {
    fs.writeFileSync(source, Buffer.from(item.data, "base64"));
    const res = spawnSync(
      command,
      [source, "-resize", `${maxEdge}x${maxEdge}>`, "-strip", "-quality", "82", target],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (res.status !== 0) return item;
    const bytes = fs.readFileSync(target);
    if (!bytes.length || bytes.length >= item.bytes) return item;
    return {
      ...item,
      data: bytes.toString("base64"),
      mimeType: "image/webp",
      bytes: bytes.length,
      originalBytes: item.bytes,
      prepared: true,
    };
  } catch {
    return item;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
