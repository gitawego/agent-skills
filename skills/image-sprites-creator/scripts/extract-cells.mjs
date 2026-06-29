#!/usr/bin/env node
/**
 * extract-cells.mjs — Crop a sprite sheet into individual frames.
 *
 * Two modes:
 *   --mode mapped   : cell rectangles come from --map (inline JSON) or --map-file
 *   --mode grid     : auto-divide into a regular N x M grid of equal-size cells
 *
 * Mapped mode (default — most reliable):
 *   node extract-cells.mjs --source sheet.png --out tmp/sprites_raw \
 *     --map '[{"key":"idle_00","x":0,"y":0,"w":256,"h":256}, ...]'
 *
 *   # or for large maps:
 *   node extract-cells.mjs --source sheet.png --out tmp/sprites_raw \
 *     --map-file cells.json
 *
 *   Each entry has `key` (frame filename), `x`, `y`, `w`, `h` in source pixels.
 *   Set --inset N to drop N px from each side of every cell (removes thin borders).
 *   Set --resize N to downscale each cell to NxN before saving.
 *
 * Grid mode (auto-divide — best effort, requires evenly-sized cells):
 *   node extract-cells.mjs --source sheet.png --out tmp/sprites_raw \
 *     --mode grid --cols 3 --rows 2 --prefix frame \
 *     --animations idle,walk,run,jump,attack,hurt
 *
 *   Divides the source into cols*rows equal cells starting at (0, 0).
 *   Frame keys are `{prefix}_{index}` left-to-right, top-to-bottom.
 *   --animations is "name:idx0,idx1,idx2|..." — written to animations.json.
 *
 * Both modes produce: PNG files in --out/, one per cell.
 *
 * Validation: out-of-bounds cells, duplicate keys, and un-divisible grids all
 * fail loudly with a single-line message. Pass --verbose for full stack traces.
 */
import sharp from 'sharp';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        args[key] = val;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** First line, truncated — used so we don't leak sharp/canvas stack traces. */
function shortError(err) {
  if (err && err.message) return err.message.split('\n')[0].slice(0, 200);
  return String(err);
}

async function loadMap(args) {
  if (!args['map-file'] && !args.map) return null;
  let raw;
  if (args['map-file']) {
    try {
      raw = await readFile(resolve(args['map-file']), 'utf-8');
    } catch (err) {
      fail(`Cannot read --map-file: ${shortError(err)}`);
    }
  } else {
    raw = args.map;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`--map / --map-file is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) fail('--map must be a JSON array of {key, x, y, w, h}');
  return parsed;
}

function validateMappedCell(cell, idx, meta) {
  if (!cell.key || typeof cell.key !== 'string') {
    fail(`cell [${idx}] missing/invalid "key" (need a non-empty string)`);
  }
  for (const k of ['x', 'y', 'w', 'h']) {
    if (typeof cell[k] !== 'number') {
      fail(`cell "${cell.key}" missing/invalid "${k}" (need a number)`);
    }
    if (cell[k] < 0) fail(`cell "${cell.key}" has negative "${k}"=${cell[k]}`);
  }
  if (cell.w === 0 || cell.h === 0) {
    fail(`cell "${cell.key}" has zero width or height`);
  }
  if (cell.x + cell.w > meta.width) {
    fail(`cell "${cell.key}" extends past image right edge: x+w=${cell.x + cell.w} > width=${meta.width}`);
  }
  if (cell.y + cell.h > meta.height) {
    fail(`cell "${cell.key}" extends past image bottom edge: y+h=${cell.y + cell.h} > height=${meta.height}`);
  }
}

/**
 * Suggest the nearest (cols, rows) that divides width/height within 1 px.
 * Used when the user passed --cols/--rows that don't divide the source.
 */
function suggestValidGrid(width, height, cols, rows) {
  let best = null;
  let bestDist = Infinity;
  for (let dc = -3; dc <= 3; dc++) {
    for (let dr = -3; dr <= 3; dr++) {
      const c = cols + dc;
      const r = rows + dr;
      if (c < 1 || r < 1) continue;
      const cellW = Math.floor(width / c);
      const cellH = Math.floor(height / r);
      if (cellW === 0 || cellH === 0) continue;
      const leftW = width - cellW * c;
      const leftH = height - cellH * r;
      if (leftW <= 1 && leftH <= 1) {
        const dist = Math.abs(c - cols) + Math.abs(r - rows);
        if (dist < bestDist) { bestDist = dist; best = { cols: c, rows: r }; }
      }
    }
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv);
  const verbose = !!args.verbose;
  const source = args.source ? resolve(args.source) : null;
  const outDir = args.out ? resolve(args.out) : null;
  const mode = args.mode || 'mapped';
  const inset = parseInt(args.inset || '0', 10);
  const resizeTo = args.resize ? parseInt(args.resize, 10) : null;
  if (!source) fail('Missing --source <path>');
  if (!outDir) fail('Missing --out <dir>');

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  let meta;
  try {
    meta = await sharp(source).metadata();
  } catch (err) {
    if (verbose) throw err;
    fail(`Cannot read source image: ${shortError(err)}`);
  }
  console.log(`Source: ${source} (${meta.width}×${meta.height} ${meta.channels}ch)`);
  console.log(`Mode: ${mode}`);

  let cells = [];
  if (mode === 'mapped') {
    const parsed = await loadMap(args);
    if (!parsed) fail('Mapped mode requires --map (JSON) or --map-file <path>');
    parsed.forEach((c, i) => validateMappedCell(c, i, meta));

    // Detect duplicate keys
    const seen = new Map();
    for (let i = 0; i < parsed.length; i++) {
      const c = parsed[i];
      if (seen.has(c.key)) {
        fail(`duplicate key "${c.key}" — entries [${seen.get(c.key)}] and [${i}] both use it`);
      }
      seen.set(c.key, i);
    }
    cells = parsed;
  } else if (mode === 'grid') {
    const cols = parseInt(args.cols, 10);
    const rows = parseInt(args.rows, 10);
    const prefix = args.prefix || 'frame';
    if (!cols || !rows) fail('Grid mode requires --cols and --rows');
    if (cols < 1 || rows < 1) fail(`--cols and --rows must be >= 1 (got ${cols}, ${rows})`);

    // Validate that the grid divides the source within 1 px.
    const cellW = Math.floor(meta.width / cols);
    const cellH = Math.floor(meta.height / rows);
    if (cellW === 0 || cellH === 0) {
      fail(`Grid too large for source: ${cols}×${rows} cells would be ${cellW}×${cellH}px. Source is ${meta.width}×${meta.height}.`);
    }
    const leftW = meta.width - cellW * cols;
    const leftH = meta.height - cellH * rows;
    if (leftW > 1 || leftH > 1) {
      const sug = suggestValidGrid(meta.width, meta.height, cols, rows);
      const hint = sug ? ` Nearest valid: --cols ${sug.cols} --rows ${sug.rows}.` : '';
      fail(`--cols ${cols} × --rows ${rows} doesn't divide ${meta.width}×${meta.height} cleanly (leftover ${leftW}×${leftH}px).${hint}`);
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        cells.push({
          key: `${prefix}_${String(idx).padStart(2, '0')}`,
          x: c * cellW,
          y: r * cellH,
          w: cellW,
          h: cellH,
        });
      }
    }
    console.log(`Grid: ${cols}×${rows} cells of ${cellW}×${cellH}px → ${cells.length} frames`);
  } else {
    fail(`Unknown --mode: ${mode} (use 'mapped' or 'grid')`);
  }

  // Optional animations map (only for grid mode convenience)
  if (args.animations) {
    if (mode !== 'grid') {
      console.warn('(ignoring --animations in mapped mode — animations come from your --map metadata)');
    } else {
      const animations = {};
      for (const part of args.animations.split('|')) {
        const [name, idxs] = part.split(':');
        if (!name || !idxs) fail(`Bad --animations entry: ${part} (expected "name:idx,idx,...")`);
        animations[name.trim()] = idxs.split(',').map((s) => parseInt(s.trim(), 10));
      }
      const animsOut = args['animations-out']
        ? resolve(args['animations-out'])
        : join(outDir, 'animations.json');
      await writeFile(
        animsOut,
        JSON.stringify(
          {
            prefix: args.prefix || 'frame',
            animations: Object.entries(animations).map(([key, idxs]) => ({
              key,
              frames: idxs.map((i) => `${args.prefix || 'frame'}_${String(i).padStart(2, '0')}`),
            })),
          },
          null,
          2,
        ),
      );
      console.log(`Wrote animation map: ${animsOut}`);
    }
  }

  // Crop + (optional) resize
  let count = 0;
  for (const cell of cells) {
    const x = cell.x + inset;
    const y = cell.y + inset;
    const w = cell.w - 2 * inset;
    const h = cell.h - 2 * inset;
    if (w <= 0 || h <= 0) {
      console.warn(`  [SKIP] ${cell.key} — negative size after inset`);
      continue;
    }
    const out = join(outDir, `${cell.key}.png`);
    let pipe = sharp(source).extract({ left: x, top: y, width: w, height: h });
    if (resizeTo) pipe = pipe.resize(resizeTo, resizeTo, { fit: 'fill' });
    try {
      await pipe.png().toFile(out);
      count += 1;
    } catch (err) {
      if (verbose) throw err;
      fail(`Failed to write ${out}: ${shortError(err)}`);
    }
  }

  if (resizeTo) console.log(`  (each cell resized to ${resizeTo}×${resizeTo})`);
  console.log(`✓ Extracted ${count} frames to ${outDir}`);
}

main().catch((err) => {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  if (verbose) {
    console.error(err);
  } else {
    console.error(`✗ ${err && err.message ? err.message.split('\n')[0] : err}`);
  }
  process.exit(1);
});