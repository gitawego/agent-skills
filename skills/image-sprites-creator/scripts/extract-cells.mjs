#!/usr/bin/env node
/**
 * extract-cells.mjs — Crop a sprite sheet into individual frames.
 *
 * Two modes:
 *   --mode mapped   : cell rectangles come from --map (JSON or inline list)
 *   --mode grid     : auto-detect a regular N x M grid of equal-size cells
 *
 * Mapped mode (default — most reliable):
 *   node extract-cells.mjs --source sheet.png --out tmp/sprites_raw \
 *     --map '[{"key":"idle_00","x":0,"y":0,"w":256,"h":256}, ...]'
 *
 *   The --map value is a JSON array of {key, x, y, w, h} objects. The key is
 *   the frame name (e.g. "idle_00"); x/y/w/h are pixel bounds in the source.
 *   Inset defaults to 0 (no padding) — set --inset N to drop N px from each
 *   side of every cell (useful for removing thin grid borders).
 *
 * Grid mode (auto-detect — best effort, requires evenly-sized cells):
 *   node extract-cells.mjs --source sheet.png --out tmp/sprites_raw \
 *     --mode grid --cols 3 --rows 2 --prefix idle \
 *     --animations idle,walk,run,jump,attack,hurt
 *
 *   The script divides the source into cols*rows equal cells starting at
 *   (0, 0). Frame keys are auto-named `{prefix}_{index}` left-to-right,
 *   top-to-bottom. The --animations list maps animation names to the frame
 *   indices they contain (comma-separated, e.g. "0,1,2,3" for the first
 *   four cells being the "idle" animation). The animation map is written
 *   to --animations-out (default: tmp/sprites_raw/animations.json).
 *
 * Both modes produce the same output: PNG files in --out/, one per cell.
 */
import sharp from 'sharp';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');

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

async function main() {
  const args = parseArgs(process.argv);
  const source = args.source ? resolve(args.source) : null;
  const outDir = args.out ? resolve(args.out) : null;
  const mode = args.mode || 'mapped';
  const inset = parseInt(args.inset || '0', 10);
  if (!source) fail('Missing --source <path>');
  if (!outDir) fail('Missing --out <dir>');

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const meta = await sharp(source).metadata();
  console.log(`Source: ${source} (${meta.width}×${meta.height} ${meta.channels}ch)`);
  console.log(`Mode: ${mode}`);

  let cells = [];
  if (mode === 'mapped') {
    if (!args.map) fail('Mapped mode requires --map (JSON array of {key,x,y,w,h})');
    let parsed;
    try {
      parsed = JSON.parse(args.map);
    } catch (e) {
      fail(`--map is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(parsed)) fail('--map must be a JSON array');
    cells = parsed.map((c, i) => {
      if (!c.key) fail(`Cell ${i} missing "key"`);
      for (const k of ['x', 'y', 'w', 'h']) {
        if (typeof c[k] !== 'number') fail(`Cell ${c.key} missing/invalid "${k}"`);
      }
      return c;
    });
  } else if (mode === 'grid') {
    const cols = parseInt(args.cols, 10);
    const rows = parseInt(args.rows, 10);
    const prefix = args.prefix || 'frame';
    if (!cols || !rows) fail('Grid mode requires --cols and --rows');
    const cellW = Math.floor(meta.width / cols);
    const cellH = Math.floor(meta.height / rows);
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
  let animations = null;
  if (args.animations) {
    if (mode !== 'grid') {
      console.warn('(ignoring --animations in mapped mode — animations come from your --map metadata)');
    } else {
      // --animations format: "name:idx0,idx1,idx2|name:idx0,idx1"
      animations = {};
      for (const part of args.animations.split('|')) {
        const [name, idxs] = part.split(':');
        if (!name || !idxs) fail(`Bad --animations entry: ${part}`);
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

  // Crop
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
    await sharp(source)
      .extract({ left: x, top: y, width: w, height: h })
      .png()
      .toFile(out);
    count += 1;
  }

  console.log(`✓ Extracted ${count} frames to ${outDir}`);
}

main().catch((err) => {
  console.error('extract-cells failed:', err);
  process.exit(1);
});
