/* Orchestration: image -> colour layers -> regions -> stitch runs -> machine commands. */
(function (E) {
  'use strict';
  const I = E.img;
  const { STITCH, JUMP, COLOR, END } = E.pes;

  const DEFAULTS = {
    // image
    colors: 6,
    mergeSimilar: 10,        // merge colours whose threads are closer than this (CIEDE2000)
    foldTinyColors: true,    // fold tiny, similar colours into their neighbour (saves a stop each)
    tinyColor: 15,           // mm^2: "tiny"
    background: 'outside',   // outside | all | keep
    mergeBlends: true,       // dissolve anti-aliasing colours
    snapToThreads: true,
    smoothing: 3,            // edge smoothing strength (x 0.09mm Gaussian sigma)
    minRegion: 0.6,          // mm^2; smaller specks merge into neighbours
    // fill
    angle: 45,
    autoAngle: true,
    spacing: 0.42,           // mm between fill rows (density)
    stitchLength: 3.5,       // mm
    pattern: 'tatami',
    underlay: 'both',        // none | edge | fill | both
    underlaySpacing: 2.0,
    underlayInset: 0.9,
    pullComp: 0.15,          // mm added to each end of fill rows; satin scales it with column width
    overlap: 0.25,           // mm each region grows into its neighbours (avoids gaps)
    // satin
    satin: true,
    satinMax: 5.5,           // regions narrower than this (mm) are sewn as satin
    satinSpacing: 0.4,
    satinMinWidth: 0.9,
    satinUnderlay: 'auto',   // auto | center | zigzag | none
    zigzagUnderlayMin: 2.4,
    zigzagUnderlaySpacing: 1.6,
    satinMaxStitch: 7.0,
    shortStitch: true,
    // machine
    trimDistance: 1.0,       // jumps longer than this get a trim + tie stitches...
    connectMax: 4,           // ...unless the connector is this short and lies entirely on stitching
    buryConnectors: true,    // route connectors under not-yet-sewn stitching instead of trimming
    ties: true,
    minStitch: 0.5,
  };

  const tick = () => new Promise((r) => setTimeout(r, 0));

  /**
   * Step 1: colour analysis. img = {data,width,height} at working resolution; res = mm per pixel.
   */
  function analyze(img, res, s) {
    const L = I.toLab(img);
    const bgMode = s.background || (s.removeBackground === false ? 'keep' : 'outside');
    // cluster with a couple of spare slots (they soak up anti-aliasing blends); the colour budget
    // itself is enforced afterwards by perceptual merging in reduceColorStops
    const q = I.quantize(L, Object.assign({}, s, { colors: Math.min(16, s.colors + (s.spareClusters == null ? 0 : s.spareClusters)), removeBackground: bgMode !== 'keep' }));
    const { width: w, height: h } = img;
    const minPx = Math.max(2, s.minRegion / (res * res));
    // 1. dissolve anti-aliasing / JPEG blend colours into the real colours either side
    const labOf = q.colors.map((c, i) => (i === 0 ? (q.background && q.background.lab) || null : c.srcLab || c.lab));
    const blendsRemoved = s.mergeBlends === false ? 0 : I.mergeBlendColors(q.labels, w, h, L.lab, labOf);
    // 1b. fewer colour stops: every colour is a machine stop for a thread change (a "sequence step")
    const colorsMerged = reduceColorStops(q, w, h, res, s);
    // 2. smooth edges (scale-aware, in mm) and drop specks
    if (s.smoothing > 0) {
      I.majorityFilter(q.labels, w, h, 1);
      I.smoothLabels(q.labels, w, h, (s.smoothing * 0.09) / res);
    }
    I.removeSmallRegions(q.labels, w, h, minPx);
    // 3. background-coloured areas enclosed by the design (eyes, highlights) are artwork, not background
    if (bgMode === 'outside' && q.background && q.background.lab) {
      const { list } = I.components(q.labels, w, h, 4, true, (l) => l === 0);
      // An enclosed background-coloured area is artwork (an eye white) when it is compact AND has
      // something inside it (a pupil). Empty holes - letter counters (e, o, B), gaps between legs or
      // between an arm and the body - are fabric showing through. Clicking a shape overrides this.
      const inner = list.filter((c) => {
        if (c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1 || c.size < minPx) return false;
        const info = I.shapeInfo(c, w);
        return info.circularity >= (s.enclosedCircularity || 0.6) && info.inner >= Math.max(4, minPx * 0.5);
      });
      if (inner.length) {
        const bl = q.background.lab;
        const t = E.nearestThread(bl);
        let label = s.snapToThreads ? q.colors.findIndex((c, i) => i > 0 && c.thread.index === t.index) : -1;
        if (label < 0) {
          q.colors.push(s.snapToThreads
            ? { lab: t.lab, rgb: t.rgb.slice(), thread: t, srcLab: bl, enclosedBackground: true }
            : { lab: bl, rgb: E.labToRgb(bl[0], bl[1], bl[2]), thread: t, srcLab: bl, enclosedBackground: true });
          label = q.colors.length - 1;
        }
        for (const c of inner) for (const i of c.pixels) q.labels[i] = label;
      }
    }
    // 4. respect the colour budget (every colour is one thread change / sequence step)
    const budgetDropped = enforceColorBudget(q, L.lab, w, h, res, s);
    if (budgetDropped && s.smoothing > 0) I.majorityFilter(q.labels, w, h, 1);
    // drop colours that vanished, compact the label ids
    const counts = new Array(q.colors.length).fill(0);
    for (let i = 0; i < q.labels.length; i++) counts[q.labels[i]]++;
    const remap = new Uint8Array(q.colors.length);
    const colors = [{ background: true, count: counts[0] }];
    for (let c = 1; c < q.colors.length; c++) {
      if (counts[c] === 0) continue;
      remap[c] = colors.length;
      colors.push(Object.assign({}, q.colors[c], { count: counts[c], include: true }));
    }
    for (let i = 0; i < q.labels.length; i++) q.labels[i] = remap[q.labels[i]];
    return { labels: q.labels, colors, width: w, height: h, res, background: q.background, blendsRemoved, colorsMerged };
  }

  /**
   * Reduce thread changes:
   *  - colours whose threads are perceptually near-identical (CIEDE2000 < mergeSimilar) are merged;
   *  - tiny colours (< tinyColor mm^2 in total) that are reasonably similar to the colour they
   *    mostly touch are folded into it. Small but distinct colours (an orange beak) are kept.
   */
  function reduceColorStops(q, w, h, res, s) {
    const labels = q.labels, K = q.colors.length, n = w * h;
    const lab = (l) => (q.colors[l].thread && s.snapToThreads ? q.colors[l].thread.lab : q.colors[l].lab);
    const count = new Float64Array(K);
    for (let i = 0; i < n; i++) count[labels[i]]++;
    const remap = (from, to) => {
      for (let i = 0; i < n; i++) if (labels[i] === from) labels[i] = to;
      count[to] += count[from]; count[from] = 0;
    };
    let merged = 0;
    const tol = s.mergeSimilar == null ? 10 : s.mergeSimilar;
    for (;;) {
      let best = null;
      for (let a = 1; a < K; a++) for (let b = a + 1; b < K; b++) {
        if (!count[a] || !count[b]) continue;
        const d = E.deltaE2000(lab(a), lab(b));
        if (d < tol && (!best || d < best.d)) best = { a, b, d };
      }
      if (!best) break;
      const [big, small] = count[best.a] >= count[best.b] ? [best.a, best.b] : [best.b, best.a];
      remap(small, big); merged++;
    }
    if (s.foldTinyColors !== false) {
      const tinyPx = (s.tinyColor || 15) / (res * res);
      for (;;) {
        // adjacency between colours (4-neighbour boundary counts)
        const adj = new Float64Array(K * K);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x, l = labels[i];
          if (x + 1 < w && labels[i + 1] !== l) { adj[l * K + labels[i + 1]]++; adj[labels[i + 1] * K + l]++; }
          if (y + 1 < h && labels[i + w] !== l) { adj[l * K + labels[i + w]]++; adj[labels[i + w] * K + l]++; }
        }
        let done = true;
        for (let t = 1; t < K; t++) {
          if (!count[t] || count[t] >= tinyPx) continue;
          let nb = -1, na = 0;
          for (let o = 1; o < K; o++) if (o !== t && count[o] && adj[t * K + o] > na) { na = adj[t * K + o]; nb = o; }
          if (nb > 0 && E.deltaE2000(lab(t), lab(nb)) < 25) { remap(t, nb); merged++; done = false; break; }
        }
        if (done) break;
      }
    }
    return merged;
  }

  /**
   * Enforce the colour budget (= max thread changes). Repeatedly drop the colour that costs least to
   * lose - smallest area x perceptual difference to its nearest remaining colour - and give each of
   * its pixels to whichever remaining colour that pixel actually resembles.
   */
  function enforceColorBudget(q, pixLab, w, h, res, s) {
    const labels = q.labels, K = q.colors.length, n = w * h;
    const budget = Math.max(1, s.colors | 0);
    const tl = (l) => (q.colors[l].thread && s.snapToThreads ? q.colors[l].thread.lab : q.colors[l].lab);
    const src = (l) => q.colors[l].srcLab || q.colors[l].lab;
    const count = new Float64Array(K);
    for (let i = 0; i < n; i++) count[labels[i]]++;
    let dropped = 0;
    for (;;) {
      const alive = [];
      for (let l = 1; l < K; l++) if (count[l]) alive.push(l);
      if (alive.length <= budget) break;
      let best = null;
      for (const a of alive) {
        let near = Infinity;
        for (const b of alive) if (b !== a) near = Math.min(near, E.deltaE2000(tl(a), tl(b)));
        const cost = count[a] * near;
        if (!best || cost < best.cost) best = { a, cost };
      }
      const rest = alive.filter((l) => l !== best.a);
      for (let i = 0; i < n; i++) {
        if (labels[i] !== best.a) continue;
        const p = [pixLab[i * 3], pixLab[i * 3 + 1], pixLab[i * 3 + 2]];
        let to = rest[0], bd = Infinity;
        for (const l of rest) { const d = E.labDist2(p, src(l)); if (d < bd) { bd = d; to = l; } }
        labels[i] = to; count[to]++;
      }
      count[best.a] = 0;
      dropped++;
    }
    return dropped;
  }

  /** Collects stitch runs for one region; a run is a polyline sewn without jumping. */
  class RunBuilder {
    constructor(pen, traveler, travelLen) {
      this.pen = pen; this.traveler = traveler; this.travelLen = travelLen;
      this.runs = []; this.cur = null;
    }
    moveTo(p) {
      if (this.kind) p = [p[0], p[1], this.kind];
      if (!this.cur) { this.cur = [p]; this.runs.push(this.cur); this.pen = p; return; }
      const d = Math.hypot(p[0] - this.pen[0], p[1] - this.pen[1]);
      if (d < 0.45) return; // a hop this small would only make a tiny stitch; the next stitch covers it
      const route = this.traveler ? this.traveler.route(this.pen, p, this.travelLen) : null;
      if (route && (I.polyLength([this.pen].concat(route)) < Math.max(12, d * 3))) { this.add(route, 't'); return; }
      this.cur = [p]; this.runs.push(this.cur); this.pen = p;
    }
    add(pts, kind) {
      if (!this.cur) { this.cur = []; this.runs.push(this.cur); }
      const k = kind || this.kind;
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i];
        // underlay and travel are hidden: never spend a needle penetration on a sub-0.45mm hop
        if (this.cur.length) {
          const last = this.cur[this.cur.length - 1];
          if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 0.45) {
            if (k && i < pts.length - 1) continue;
            // final point of a hidden run lands next to a hidden point: replace that point instead
            if (last[2] && this.cur.length > 1) this.cur.pop();
          }
        }
        this.cur.push(k ? [q[0], q[1], k] : q);
      }
      if (pts.length) this.pen = pts[pts.length - 1];
    }
  }

  /**
   * Step 2: generate stitches. Returns a design: { layers:[{colorIndex, thread, rgb, runs, regions}], stats }
   */
  async function generate(an, s, onProgress) {
    const { labels, colors, width: w, height: h, res } = an;
    const regions = E.buildRegions(labels, w, h, res, (l) => colors[l] && colors[l].include, s.overlap);
    const byLabel = new Map();
    for (const r of regions) {
      if (!byLabel.has(r.label)) byLabel.set(r.label, []);
      byLabel.get(r.label).push(r);
    }
    // stitch large colour areas first, fine detail (often outlines) last
    // Sewing order: thickest colours first, thinnest last. Broad fills go down first and thin
    // strokes (outlines, lettering, details) are sewn last so they sit crisply on top of whatever
    // they border - e.g. a black eye outline over the white of the eye, never the other way round.
    const info = new Map();
    for (const [l, rs] of byLabel) {
      let area = 0, thick = 0;
      for (const r of rs) {
        let sum = 0, n = 0;
        const dt = r.dtIn;
        for (let i = 0; i < dt.length; i++) if (r.mask[i]) { sum += dt[i]; n++; }
        // mean distance-to-edge ~ width/4 for a stroke, R/3 for a disc: a robust "how thick" measure
        area += r.area; thick += (n ? (sum / n) * r.res : 0) * r.area;
      }
      info.set(l, { area, thick: thick / Math.max(area, 1e-9) });
    }
    const order = [...byLabel.keys()].sort((a, b) => {
      const A = info.get(a), B = info.get(b);
      return B.thick - A.thick || B.area - A.area;
    });
    if (s.colorOrder && s.colorOrder.length) {
      order.sort((a, b) => {
        const ia = s.colorOrder.indexOf(a), ib = s.colorOrder.indexOf(b);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      });
    }
    // one-way overlap: each region grows only under colours that are sewn after it
    const rank = new Map(order.map((l, i) => [l, i]));
    for (const r of regions) {
      const mine = rank.get(r.label);
      r.growInto = new Set(order.filter((l) => rank.get(l) > mine));
    }
    /** true if a short connector a->b lies entirely on stitched area (never over bare fabric):
     *  such a thread is practically invisible, so it is cheaper than a trim + new sequence step */
    function connectable(a, b) {
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d > (s.connectMax == null ? 4 : s.connectMax)) return false;
      const n = Math.max(1, Math.ceil(d / (res * 0.7)));
      for (let i = 0; i <= n; i++) {
        const x = Math.floor((a[0] + (b[0] - a[0]) * i / n) / res), y = Math.floor((a[1] + (b[1] - a[1]) * i / n) / res);
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        const l = labels[y * w + x];
        if (!l || !colors[l] || !colors[l].include) return false;
      }
      return true;
    }
    // region id per pixel, so connectors can be routed under regions that are not sewn yet
    const regionId = new Int32Array(w * h).fill(-1);
    regions.forEach((r, id) => {
      r.id = id;
      for (let ly = 0; ly < r.h; ly++) for (let lx = 0; lx < r.w; lx++) {
        if (!r.mask[ly * r.w + lx]) continue;
        const x = r.ox + lx, y = r.oy + ly;
        if (x >= 0 && y >= 0 && x < w && y < h) regionId[y * w + x] = id;
      }
    });
    const G = Math.max(1, Math.round(0.5 / res)); // routing grid cell ~0.5mm
    const gw = Math.ceil(w / G), gh = Math.ceil(h / G);
    /**
     * Route a connector a->b for colour `label` that stays buried: it may only run under colours
     * sewn later, or under regions of this colour that have not been sewn yet (`sewn` = done ids).
     * Returns stitch points (excluding a) or null.
     */
    function hiddenRoute(a, b, label, sewn) {
      const own = rank.get(label);
      const ok = (cx, cy, ends) => {
        const x = Math.min(w - 1, cx * G + (G >> 1)), y = Math.min(h - 1, cy * G + (G >> 1));
        const i = y * w + x, l = labels[i];
        if (!l || !colors[l] || !colors[l].include) return false;
        if (l === label) return ends || (regionId[i] >= 0 && !sewn.has(regionId[i]));
        return rank.get(l) > own;
      };
      const cell = (p) => [Math.min(gw - 1, Math.max(0, Math.floor(p[0] / res / G))), Math.min(gh - 1, Math.max(0, Math.floor(p[1] / res / G)))];
      const [sx, sy] = cell(a), [tx, ty] = cell(b);
      const nearEnd = (cx, cy) => Math.hypot(cx - sx, cy - sy) * G * res <= 1.2 || Math.hypot(cx - tx, cy - ty) * G * res <= 1.2;
      const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const limit = Math.min(60, straight * 2.5 + 8) / (G * res);
      const gScore = new Map(), from = new Map(), open = [[0, sx, sy]];
      const key = (x, y) => y * gw + x;
      gScore.set(key(sx, sy), 0);
      let found = false, iter = 0;
      while (open.length && iter++ < 40000) {
        // small open lists: linear pop of the best f is fine
        let bi = 0;
        for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
        const [, x, y] = open[bi]; open[bi] = open[open.length - 1]; open.pop();
        if (x === tx && y === ty) { found = true; break; }
        const g0 = gScore.get(key(x, y));
        if (g0 > limit) continue;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          if (!ok(nx, ny, nearEnd(nx, ny))) continue;
          const ng = g0 + (dx && dy ? 1.414 : 1), k = key(nx, ny);
          if (ng < (gScore.has(k) ? gScore.get(k) : Infinity)) {
            gScore.set(k, ng); from.set(k, key(x, y));
            open.push([ng + Math.hypot(tx - nx, ty - ny), nx, ny]);
          }
        }
      }
      if (!found) return null;
      const pts = [];
      for (let k = key(tx, ty); k !== key(sx, sy); k = from.get(k)) pts.push([((k % gw) * G + G / 2) * res, (Math.floor(k / gw) * G + G / 2) * res]);
      pts.reverse();
      // string-pull while every sample of each straight piece stays buried
      const lineOk = (p, q) => {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]), n = Math.max(1, Math.ceil(d / (G * res * 0.5)));
        for (let i = 0; i <= n; i++) {
          const c = cell([p[0] + (q[0] - p[0]) * i / n, p[1] + (q[1] - p[1]) * i / n]);
          if (!ok(c[0], c[1], nearEnd(c[0], c[1]))) return false;
        }
        return true;
      };
      const all = [a].concat(pts, [b]), out = [a];
      let i = 0;
      while (i < all.length - 1) {
        let j = all.length - 1;
        while (j > i + 1 && !lineOk(all[i], all[j])) j--;
        out.push(all[j]); i = j;
      }
      return I.subdivide(out, 2.5).slice(1);
    }
    /** true if a straight run a->b only crosses this colour or colours sewn later (which bury it) */
    const hidden = (a, b, label) => {
      const own = rank.get(label);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(d / (res * 0.7)));
      for (let i = 0; i <= n; i++) {
        const x = Math.floor((a[0] + (b[0] - a[0]) * i / n) / res), y = Math.floor((a[1] + (b[1] - a[1]) * i / n) / res);
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        const l = labels[y * w + x];
        // own colour only right at the two pieces being joined (elsewhere it may already be sewn)
        if (l === label && Math.min(i, n - i) / n * d <= 1.0) continue;
        if (!l || !colors[l] || !colors[l].include || !(rank.get(l) > own)) return false;
      }
      return true;
    };
    const layers = [];
    let pen = null, done = 0;
    const total = regions.length;
    const stats = { fill: 0, satin: 0, regions: total };
    for (const label of order) {
      const todo = new Set(byLabel.get(label));
      // the biggest piece (for cartoons: the outline network) is sewn last, so connectors between
      // the smaller pieces can be routed underneath it and get buried instead of trimmed
      const backbone = s.buryConnectors !== false && byLabel.get(label).length > 2 ? byLabel.get(label).reduce((a, b) => (b.area > a.area ? b : a)) : null;
      if (backbone) todo.delete(backbone);
      let backboneDone = false;
      const layer = { colorIndex: label, color: colors[label], runs: [], regions: [] };
      while (todo.size || (backbone && !backboneDone)) {
        if (!todo.size) { todo.add(backbone); backboneDone = true; }
        // nearest region to the current needle position
        // nearest region, preferring ones reachable without a trim (each trim = a new sequence step)
        let next = null, nd = Infinity;
        for (const r of todo) {
          let d = -r.area;
          if (pen) {
            const nb = r.nearestBoundary(pen);
            d = nb.dist;
            if (d > s.trimDistance && !(connectable(pen, nb.point) || hidden(pen, nb.point, label))) d += 1000;
          }
          if (d < nd) { nd = d; next = r; }
        }
        todo.delete(next);
        const traveler = new E.Traveler(next, next.field);
        const ctx = new RunBuilder(pen, traveler, 2.5);
        let kind = 'fill';
        if (s.satin && next.maxWidth <= s.satinMax) {
          const res2 = E.satin.satinRegion(ctx, next, s);
          if (res2) kind = 'satin';
          else { ctx.runs = []; ctx.cur = null; ctx.pen = pen; }
        }
        let info = null;
        if (kind === 'fill') info = E.fill.fillRegion(ctx, next, s);
        stats[kind]++;
        for (const r of ctx.runs) if (r.length) { r.region = next.id; layer.runs.push(r); }
        layer.regions.push({ kind, area: next.area, angle: info && info.angle });
        if (ctx.pen) pen = ctx.pen;
        done++;
        if (onProgress && done % 3 === 0) { onProgress(done / total); await tick(); }
      }
      if (layer.runs.length) layers.push(layer);
    }
    return { layers, stats, width: w * res, height: h * res, hidden, connectable, hiddenRoute };
  }

  // ------------------------------------------------------------ assembly
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  function cleanRun(run, minStitch) {
    const out = [run[0]];
    for (let i = 1; i < run.length; i++) {
      const p = run[i];
      if (dist(p, out[out.length - 1]) >= minStitch) out.push(p);
      else if (i === run.length - 1 && out.length > 1) out[out.length - 1] = p;
    }
    return out;
  }

  /**
   * Step 3: turn layers into machine commands with ties, trims and colour changes.
   * threadFor(layer) -> PEC thread object
   */
  function assemble(design, s, threadFor) {
    const cmds = [];
    const colorIdx = [];
    const blocks = [];
    let pen = null, prevThread = null;
    const tieLen = 0.6;
    let last = null;
    const push = (p, c, extra) => {
      // never emit needle penetrations closer than 0.3mm: they shred thread and cause nesting
      if (c === STITCH && last && last.c === STITCH && Math.hypot(p[0] - last.x, p[1] - last.y) < 0.3) return;
      last = Object.assign({ x: p[0], y: p[1], c, k: p[2] }, extra);
      cmds.push(last);
    };
    const tieIn = (pts) => {
      const p0 = pts[0];
      const q = pts.find((q) => dist(q, p0) >= 0.5);
      if (!q) return;
      const d = dist(q, p0), t = Math.min(tieLen, d * 0.8);
      const a = [p0[0] + (q[0] - p0[0]) / d * t, p0[1] + (q[1] - p0[1]) / d * t];
      push(a, STITCH); push(p0, STITCH);
    };
    const tieOff = (pts) => {
      const e = pts[pts.length - 1];
      let o = null;
      for (let i = pts.length - 2; i >= 0; i--) if (dist(pts[i], e) >= 0.5) { o = pts[i]; break; }
      if (!o) return;
      const d = dist(o, e), t = Math.min(tieLen, d * 0.8);
      push([e[0] + (o[0] - e[0]) / d * t, e[1] + (o[1] - e[1]) / d * t], STITCH); push(e, STITCH);
    };
    let jumps = 0, trims = 0;
    for (const layer of design.layers) {
      const thread = threadFor(layer);
      let lastRun = null;
      if (prevThread) {
        if (thread.index !== prevThread.index) {
          cmds.push({ c: COLOR }); last = null;
          colorIdx.push(thread.index);
          blocks.push({ thread, layer });
          pen = null;
        }
      } else { colorIdx.push(thread.index); blocks.push({ thread, layer }); }
      prevThread = thread;
      const sewn = new Set();
      let hr = null;
      for (const raw of layer.runs) {
        const run = cleanRun(raw, Math.min(0.3, s.minStitch));
        if (run.length < 2) continue;
        const start = run[0];
        const gapLen = pen ? dist(pen, start) : Infinity;
        if (pen && gapLen > s.trimDistance && gapLen <= 20 && design.hidden && design.hidden(pen, start, layer.colorIndex)) {
          // no trim needed: the connecting run is buried under a colour that is sewn later
          for (const q of I.subdivide([pen, start], 2.5).slice(1)) push([q[0], q[1], 't'], STITCH);
        } else if (pen && gapLen > s.trimDistance && design.hiddenRoute && s.buryConnectors !== false &&
          (hr = design.hiddenRoute(pen, start, layer.colorIndex, sewn))) {
          // routed underneath not-yet-sewn stitching of this colour / later colours: buried, no trim
          for (const q of hr) push([q[0], q[1], 't'], STITCH);
        } else if (pen && gapLen > s.trimDistance && design.connectable && design.connectable(pen, start)) {
          // short connector lying on stitching: practically invisible, saves a trim and a sequence step
          for (const q of I.subdivide([pen, start], 2.5).slice(1)) push([q[0], q[1], 't'], STITCH);
        } else if (!pen || gapLen > s.trimDistance) {
          if (pen) {
            if (s.ties && lastRun) tieOff(lastRun);
            trims++;
          }
          // every jump except the very first carries the trim flag (matches Brother/pyembroidery output)
          push(start, JUMP, { trim: cmds.length > 0 });
          jumps++;
          push(start, STITCH);
          if (s.ties) tieIn(run);
        } else {
          for (const q of I.subdivide([pen, start], 3).slice(1)) push([q[0], q[1], 't'], STITCH);
        }
        for (let i = 1; i < run.length; i++) push(run[i], STITCH);
        pen = run[run.length - 1];
        lastRun = run;
        if (raw.region != null) sewn.add(raw.region);
      }
      if (s.ties && lastRun) tieOff(lastRun);
    }
    cmds.push({ c: END });
    let stitches = 0;
    for (const c of cmds) if (c.c === STITCH) stitches++;
    // separately started stitch runs = what embroidery software lists as sequence items
    const runs = cmds.filter((c) => c.c === JUMP).length;
    return { cmds, colorIdx, blocks, stats: { stitches, jumps, trims, runs, colors: colorIdx.length } };
  }

  E.digitize = { DEFAULTS, analyze, generate, assemble };
})(globalThis.Emb = globalThis.Emb || {});
