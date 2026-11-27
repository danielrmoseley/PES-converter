#!/usr/bin/env node
/* Headless test: renders a synthetic anti-aliased test image, runs the full
 * digitizing pipeline and writes a .pes file.
 *   node tools/test-node.js [out.pes] [imageScene]
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

function scene(W, H) {
  const data = new Uint8ClampedArray(W * H * 4);
  const shapes = [
    // [rgb, insideFn]
    [[220, 30, 40], (x, y) => (x - 130) ** 2 + (y - 150) ** 2 < 80 ** 2],                       // disc -> fill
    [[20, 70, 170], (x, y) => { const r = Math.hypot(x - 330, y - 150); return r < 90 && r > 75; }], // ring -> satin
    [[20, 20, 20], (x, y) => { const c = 330 + 28 * Math.sin((x - 40) / 45); return x > 40 && x < 340 && Math.abs(y - c) < 7; }], // wave stroke -> satin
    [[40, 160, 60], (x, y) => x > 380 && x < 480 && y > 250 && y < 390 && !(x > 410 && x < 450 && y > 290 && y < 350)], // frame w/ hole
    [[250, 200, 30], (x, y) => (x - 130) ** 2 + (y - 150) ** 2 < 30 ** 2],                     // yellow centre on disc
  ];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = [0, 0, 0];
    const N = 3;
    for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
      const px = x + (sx + 0.5) / N, py = y + (sy + 0.5) / N;
      let c = [255, 255, 255];
      for (const [rgb, f] of shapes) if (f(px, py)) c = rgb;
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
    }
    const i = (y * W + x) * 4;
    data[i] = acc[0] / (N * N); data[i + 1] = acc[1] / (N * N); data[i + 2] = acc[2] / (N * N); data[i + 3] = 255;
  }
  return { data, width: W, height: H };
}

(async () => {
  const out = process.argv[2] || path.join(root, 'test.pes');
  // optional: raw RGBA input  ->  node tools/test-node.js out.pes file.rgba W H [widthMM]
  let W = 500, H = 400, widthMM = 100, img;
  if (process.argv[3]) {
    W = +process.argv[4]; H = +process.argv[5]; widthMM = +(process.argv[6] || 100);
    img = { data: new Uint8ClampedArray(fs.readFileSync(process.argv[3])), width: W, height: H };
  } else img = scene(W, H);
  const s = Object.assign({}, E.digitize.DEFAULTS, { colors: 6 });
  const res = widthMM / W;
  let t = Date.now();
  const an = E.digitize.analyze(img, res, s);
  console.log('analyze', Date.now() - t, 'ms; colours:', an.colors.slice(1).map((c) => c.thread.name + ' (' + c.count + 'px)').join(', '));
  t = Date.now();
  const design = await E.digitize.generate(an, s);
  console.log('generate', Date.now() - t, 'ms; regions:', JSON.stringify(design.stats));
  for (const l of design.layers) console.log('  layer', l.color.thread.name, l.regions.map((r) => r.kind + (r.angle != null ? '@' + r.angle : '')).join(' '), 'runs', l.runs.length);
  const asm = E.digitize.assemble(design, s, (l) => l.color.thread);
  console.log('assemble', JSON.stringify(asm.stats));
  const bytes = E.pes.writePES(asm.cmds, asm.colorIdx, 'TEST');
  fs.writeFileSync(out, bytes);
  console.log('wrote', out, bytes.length, 'bytes');
})();
