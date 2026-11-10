// Refresh the models.dev price cache. Best-effort: a failed fetch keeps the
// previous cache and never blocks catalog discovery.
import fs from "node:fs";
import path from "node:path";
import { modelsDevFile } from "./lib/pricing.mjs";

const file = modelsDevFile();
fs.mkdirSync(path.dirname(file), { recursive: true });
const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(25_000) });
if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
const text = await res.text();
JSON.parse(text);
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, text);
fs.renameSync(tmp, file);
console.log(`prices: ${(text.length / 1024 / 1024).toFixed(1)} MB -> ${file}`);
