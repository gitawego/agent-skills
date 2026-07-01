#!/usr/bin/env node
/**
 * build-atlas.mjs — Compose individual frame PNGs into a sprite atlas
 * (atlas.png + atlas.json).
 *
 * Two ways to declare animations:
 *   1. --animations-json <path> : a JSON file with the schema below
 *   2. --animations 'name:idx1,idx2|name:idx3,idx4' : inline list
 *
 * Schema for --animations-json:
 *   {
 *     "frameSize": 256,         // optional, default 256
 *     "frameRate": 8,           // optional default for animations
 *     "defaultRepeat": -1,      // optional, default -1 (infinite)
 *     "animations": [
 *       { "key": "idle", "frames": ["idle_00", "idle_01"], "frameRate": 6, "repeat": -1 }
 *     ]
 *   }
 *
 * If neither --animations-json nor --animations is given, every frame is
 * packed into the atlas but no animation entries are written (you can add
 * them by hand later).
 *
 * Frame names are auto-resolved against the .png files in --in. Unknown
 * names produce a warning (not an error) so the build can continue.
 *
 * Usage:
 *   node build-atlas.mjs \
 *     --in tmp/sprites \
 *     --out public/assets/atlas \
 *     --animations-json tmp/sprites/animations.json
 */
import sharp from 'sharp';
import { createCanvas } from 'canvas';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
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

function shortError(err) {
  if (err && err.message) return err.message.split('\n')[0].slice(0, 200);
  return String(err);
}

/** Pick the smallest column count that fits all frames within the canvas. */
function chooseCols(frameCount, frameSize, requestedCols) {
  // Goal: pack `frameCount` items into a roughly-square grid where width <= height*2.
  const target = Math.max(1, Math.ceil(Math.sqrt(frameCount)));
  for (let c = Math.min(requestedCols, frameCount); c >= 1; c--) {
    const rows = Math.ceil(frameCount / c);
    if (rows <= c * 2) return c;
  }
  return 1;
}

async function main() {
  const args = parseArgs(process.argv);
  const verbose = !!args.verbose;
  const inDir = args.in ? resolve(args.in) : null;
  const outDir = args.out ? resolve(args.out) : null;
  if (!inDir) fail('Missing --in <dir>');
  if (!outDir) fail('Missing --out <dir>');

  const frameSize = parseInt(args['frame-size'] || '256', 10);
  if (!Number.isFinite(frameSize) || frameSize <= 0) {
    fail(`--frame-size must be a positive integer (got ${args['frame-size']})`);
  }
  const requestedCols = parseInt(args.cols || '8', 10);
  if (!Number.isFinite(requestedCols) || requestedCols <= 0) {
    fail(`--cols must be a positive integer (got ${args.cols})`);
  }

  await mkdir(outDir, { recursive: true });

  // Discover frames
  let files;
  try {
    files = (await readdir(inDir)).filter((f) => f.endsWith('.png')).sort();
  } catch (err) {
    if (verbose) throw err;
    fail(`Cannot read input dir: ${shortError(err)}`);
  }
  if (files.length === 0) fail(`No PNG files found in ${inDir}`);

  // Load animations config
  let animsConfig = { animations: [] };
  if (args['animations-json']) {
    let text;
    try {
      text = await readFile(resolve(args['animations-json']), 'utf-8');
    } catch (err) {
      if (verbose) throw err;
      fail(`Cannot read --animations-json: ${shortError(err)}`);
    }
    try {
      animsConfig = JSON.parse(text);
    } catch (e) {
      fail(`--animations-json is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(animsConfig.animations)) {
      fail(`--animations-json must have an "animations" array`);
    }
  } else if (args.animations) {
    const anims = [];
    for (const part of args.animations.split('|')) {
      const [name, idxs] = part.split(':');
      if (!name || !idxs) fail(`Bad --animations entry: ${part}`);
      anims.push({
        key: name.trim(),
        frames: idxs.split(',').map((s) => parseInt(s.trim(), 10)),
      });
    }
    animsConfig = { animations: anims };
  }

  // Build the frame list in atlas order
  const allKeys = [];
  if (animsConfig.animations.length > 0) {
    for (const a of animsConfig.animations) {
      for (const f of a.frames) {
        const key = typeof f === 'string' ? f : `frame_${String(f).padStart(2, '0')}`;
        if (!allKeys.includes(key)) allKeys.push(key);
      }
    }
  } else {
    // No animations declared — use all PNGs in sorted order
    for (const f of files) allKeys.push(f.replace('.png', ''));
  }

  if (allKeys.length === 0) fail('No frames resolved');

  // Choose cols: --atlas-fill forces the requested width, otherwise auto-fit.
  const cols = args['atlas-fill'] ? Math.min(requestedCols, allKeys.length) :
                                   chooseCols(allKeys.length, frameSize, requestedCols);
  if (!args['atlas-fill'] && cols !== requestedCols) {
    console.log(`  (auto-fit: ${allKeys.length} frames → ${cols} cols instead of requested ${requestedCols})`);
  }

  // Compute atlas dimensions
  const rows = Math.ceil(allKeys.length / cols);
  const canvas = createCanvas(frameSize * cols, frameSize * rows);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const framesJson = {};
  let placed = 0;
  let missing = 0;
  for (let i = 0; i < allKeys.length; i++) {
    const key = allKeys[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const filePath = join(inDir, `${key}.png`);

    let buf;
    try {
      buf = await sharp(filePath).png().toBuffer();
    } catch {
      console.warn(`  [SKIP] ${key} — file not found at ${filePath}`);
      missing += 1;
      continue;
    }
    const img = await loadImageFromBuffer(buf);
    ctx.drawImage(img, col * frameSize, row * frameSize);
    framesJson[key] = {
      frame: { x: col * frameSize, y: row * frameSize, w: frameSize, h: frameSize },
      rotated: false,
      trimmed: false,
      sourceSize: { w: frameSize, h: frameSize },
      spriteSourceSize: { x: 0, y: 0, w: frameSize, h: frameSize },
    };
    placed += 1;
  }

  if (placed === 0) fail('No frames could be loaded');

  // Write atlas.png
  const outPng = join(outDir, 'atlas.png');
  const atlasPng = canvas.toBuffer('image/png');
  await writeFile(outPng, atlasPng);

  // Write atlas.json (standard sprite atlas format — TexturePacker JSON-Array compatible)
  const animations = animsConfig.animations
    .filter((a) => a.frames && a.frames.length > 0)
    .map((a) => ({
      key: a.key,
      frames: (a.frames || []).map((f) => ({ key: typeof f === 'string' ? f : `frame_${String(f).padStart(2, '0')}` })),
      frameRate: a.frameRate ?? animsConfig.frameRate ?? 8,
      repeat: a.repeat ?? animsConfig.defaultRepeat ?? -1,
    }));

  const atlas = {
    frames: framesJson,
    meta: {
      image: 'atlas.png',
      size: { w: canvas.width, h: canvas.height },
      scale: '1',
      format: 'RGBA8888',
    },
    animations,
  };

  const outJson = join(outDir, 'atlas.json');
  await writeFile(outJson, JSON.stringify(atlas, null, 2));

  console.log(`✓ Atlas: ${outPng} (${canvas.width}×${canvas.height})`);
  console.log(`✓ JSON:  ${outJson}`);
  console.log(`  ${placed} frames placed, ${missing} missing, ${animations.length} animations`);
}

async function loadImageFromBuffer(buf) {
  const { Image } = await import('canvas');
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = buf;
  });
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
