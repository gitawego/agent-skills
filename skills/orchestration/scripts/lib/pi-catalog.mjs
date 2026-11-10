// The pi model table, parsed and enriched. Shared by the pi adapter and the
// legacy `catalog()` entry point without creating an import cycle.
import { spawnSync } from "node:child_process";
import { enrichModel, loadPriceMap, sortByPrice } from "./pricing.mjs";

let cache = null;

export function resetPiCatalog() {
  cache = null;
}

export function listPiModels({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const command = process.env.PI_BIN || "pi";
  const res = spawnSync(command, ["--list-models"], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) {
    const err = new Error(`\`${command} --list-models\` failed`);
    err.hint = (res.stderr || res.stdout || "no output").trim();
    throw err;
  }
  const prices = loadPriceMap();
  const rows = [];
  for (const line of (res.stdout || "").split("\n")) {
    if (!line.trim() || /^provider\s/.test(line)) continue;
    const cells = line.split(/\s{2,}/).map((c) => c.trim());
    if (cells.length < 4) continue;
    rows.push(
      enrichModel(
        {
          adapter: "pi",
          provider: cells[0],
          model: cells[1],
          context: cells[2],
          maxOut: cells[3],
          thinking: cells[4] === "yes",
          images: cells[5] === "yes",
          billing: "metered",
        },
        prices,
      ),
    );
  }
  cache = sortByPrice(rows);
  return cache;
}
