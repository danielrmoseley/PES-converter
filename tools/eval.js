#!/usr/bin/env node
/* Stitch-quality evaluation harness.
 *
 *   node tools/eval.js <suiteDir> ['{"setting":value,...}']
 *
 * <suiteDir> holds manifest.json ([{name,w,h,mm}]) and <name>.rgba raw images that are
 * already cropped/resized to working resolution (as the app does).
 *
 * For each image the full pipeline runs, the resulting stitches are rasterised with a
 * realistic thread width and scored on:
 *   Fidelity  acc     pixel accuracy vs the intended colour map (content area)
 *             edge    accuracy within 1px of a colour boundary
 *             minRec  worst per-colour recall (catches thin outlines going missing)
 *             spill   stitched pixels that should be fabric (% of content)
 *             gap     fabric showing where thread should be (% of content)
 *             wrong   pixels covered by a different colour than intended (% of content)
 *             dE      mean CIEDE2000 colour error vs the source image (includes palette error)
 *   Machine   st      stitch count       trim   trims          seq    separately started runs
 *             short   stitches < 0.4mm
 *             long    stitches > 7mm     hot    1mm^2 cells with > 14 needle penetrations
 *             stack   % content pixels covered by >= 5 stitch layers
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
for (const f of ['palette', 'imageproc', 'region', 'fill', 'satin', 'pes', 'digitize']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'js', f + '.js'), 'utf8'), { filename: f + '.js' });
}
const E = globalThis.Emb;
const { STITCH, COLOR } = E.pes;

function evaluate(img, res, s, design, an, asm) {
  const { width: w, height: h } = img;
  const n = w * h;
  const THREAD_R = 0.225 / res; // thread half-width in px
  const painted = new Int16Array(n).fill(-1);   // thread index painted on top
  const depth = new Uint8Array(n);
  let block = 0, prev = null;
  const blockThread = asm.blocks.map((b) => b.thread.index);
  const machine = { st: asm.stats.stitches, trim: asm.stats.trims, colors: asm.stats.colors, short: 0, long: 0, hot: 0,
    seq: asm.cmds.filter((c) => c.c === 1).length }; // separately started stitch runs (sequence items)
  const cells = new Map();
  const cmds = asm.cmds;
  // pull only acts where the thread turns (row ends, satin edges), not mid-row between collinear stitches
  const turns = (a, b, c2) => {
    if (!a || !c2 || a.c !== STITCH || c2.c !== STITCH) return true;
    const ux = b.x - a.x, uy = b.y - a.y, vx = c2.x - b.x, vy = c2.y - b.y;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (!lu || !lv) return true;
    return (ux * vx + uy * vy) / (lu * lv) < 0.9;
  };
  for (let ci = 0; ci < cmds.length; ci++) {
    const c = cmds[ci];
    if (c.c === COLOR) { block++; prev = null; continue; }
    if (c.c !== STITCH) { prev = c.c === 1 ? c : prev; continue; }
    const key = Math.floor(c.x) + ',' + Math.floor(c.y);
    cells.set(key, (cells.get(key) || 0) + 1);
    if (prev && prev.c === STITCH) {
      const L = Math.hypot(c.x - prev.x, c.y - prev.y);
      if (L > 0 && L < 0.4) machine.short++;
      if (L > 7) machine.long++;
      // rasterise the stitch as the thread lies on fabric: butt ends at the needle holes, and the
      // fabric pulls each end in by ~0.1mm (what pull compensation exists to counter)
      const pull = L > 1 ? Math.min(0.1, L * 0.05) / L : 0;
      const pullA = turns(cmds[ci - 2], prev, c) ? pull : 0, pullB = turns(prev, c, cmds[ci + 1]) ? pull : 0;
      const px0 = prev.x + (c.x - prev.x) * pullA, py0 = prev.y + (c.y - prev.y) * pullA;
      const px1 = c.x - (c.x - prev.x) * pullB, py1 = c.y - (c.y - prev.y) * pullB;
      const ax = px0 / res - 0.5, ay = py0 / res - 0.5, bx = px1 / res - 0.5, by = py1 / res - 0.5;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - THREAD_R)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + THREAD_R));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - THREAD_R)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + THREAD_R));
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
      const t = blockThread[block];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        let u = ((x - ax) * dx + (y - ay) * dy) / L2;
        const cap = 0.35 / Math.sqrt(L2); // allow a little rounding at the ends only
        if (u < -cap || u > 1 + cap) continue;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const ex = ax + u * dx - x, ey = ay + u * dy - y;
        if (ex * ex + ey * ey <= THREAD_R * THREAD_R) {
          const i = y * w + x;
          painted[i] = t;
          if (depth[i] < 255) depth[i]++;
        }
      }
    }
    prev = c;
  }
  for (const v of cells.values()) if (v > 14) machine.hot++;

  // expected thread per pixel
  const expect = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) { const l = an.labels[i]; if (l > 0 && an.colors[l].include) expect[i] = an.colors[l].thread.index; }
  let content = 0, correct = 0, edgeN = 0, edgeOK = 0, spill = 0, stackN = 0, gap = 0, wrong = 0;
  const recN = new Map(), recOK = new Map();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const e = expect[i], p = painted[i];
    if (e < 0 && p < 0) continue;
    content++;
    if (e === p) correct++;
    if (e < 0 && p >= 0) spill++;
    if (e >= 0 && p < 0) gap++;            // fabric showing where thread should be
    if (e >= 0 && p >= 0 && p !== e) wrong++; // covered by another colour
    if (depth[i] >= 5) stackN++;
    if (e >= 0) { recN.set(e, (recN.get(e) || 0) + 1); if (p === e) recOK.set(e, (recOK.get(e) || 0) + 1); }
    let edge = false;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + ox, yy = y + oy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && expect[yy * w + xx] !== e) edge = true;
    }
    if (edge) { edgeN++; if (e === p) edgeOK++; }
  }
  let minRec = 1;
  const perColor = [];
  for (const [k, v] of recN) if (v > 50) {
    const r = (recOK.get(k) || 0) / v;
    minRec = Math.min(minRec, r);
    perColor.push(E.threadByIndex(k).name + ' ' + (100 * r).toFixed(1));
  }
  if (process.env.EVAL_VERBOSE) console.log('   recall:', perColor.join(' | '));
  // dE vs source (fabric = detected background colour or white)
  const fabric = (an.background && an.background.lab) || E.rgbToLab(255, 255, 255);
  const thrLab = new Map(E.THREADS.map((t) => [t.index, t.lab]));
  let dE = 0, dN = 0;
  for (let i = 0; i < n; i++) {
    if (img.data[i * 4 + 3] < 128) continue;
    const src = E.rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
    const r = painted[i] >= 0 ? thrLab.get(painted[i]) : fabric;
    dE += E.deltaE2000(src, r); dN++;
  }
  return Object.assign(machine, {
    acc: correct / content, edge: edgeOK / Math.max(1, edgeN), minRec, spill: spill / content,
    gap: gap / content, wrong: wrong / content,
    dE: dE / dN, stack: stackN / content,
  });
}

(async () => {
  const dir = process.argv[2];
  const over = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const rows = [];
  for (const m of man) {
    const img = { data: new Uint8ClampedArray(fs.readFileSync(path.join(dir, m.name + '.rgba'))), width: m.w, height: m.h };
    const res = m.mm / m.w;
    const s = Object.assign({}, E.digitize.DEFAULTS, over);
    const t0 = Date.now();
    const an = E.digitize.analyze(img, res, s);
    const design = await E.digitize.generate(an, s);
    const asm = E.digitize.assemble(design, s, (l) => l.color.thread);
    const r = evaluate(img, res, s, design, an, asm);
    r.ms = Date.now() - t0;
    r.name = m.name;
    rows.push(r);
  }
  const cols = [['name', 8, (v) => v], ['acc', 6, (v) => (100 * v).toFixed(1)], ['edge', 6, (v) => (100 * v).toFixed(1)],
    ['minRec', 7, (v) => (100 * v).toFixed(1)], ['spill', 6, (v) => (100 * v).toFixed(2)], ['gap', 6, (v) => (100 * v).toFixed(2)], ['wrong', 6, (v) => (100 * v).toFixed(2)], ['dE', 6, (v) => v.toFixed(2)],
    ['st', 7, (v) => v], ['trim', 5, (v) => v], ['seq', 5, (v) => v], ['short', 6, (v) => v], ['long', 5, (v) => v], ['hot', 5, (v) => v],
    ['stack', 6, (v) => (100 * v).toFixed(2)], ['ms', 6, (v) => v]];
  console.log(cols.map(([k, w]) => k.padStart(w)).join(' '));
  for (const r of rows) console.log(cols.map(([k, w, f]) => String(f(r[k])).padStart(w)).join(' '));
  const avg = { name: 'MEAN' };
  for (const [k] of cols.slice(1)) avg[k] = rows.reduce((a, r) => a + r[k], 0) / rows.length;
  avg.st = Math.round(avg.st); avg.trim = Math.round(avg.trim); avg.seq = Math.round(avg.seq); avg.short = Math.round(avg.short); avg.long = Math.round(avg.long); avg.hot = Math.round(avg.hot); avg.ms = Math.round(avg.ms);
  console.log(cols.map(([k, w, f]) => String(f(avg[k])).padStart(w)).join(' '));
})();
