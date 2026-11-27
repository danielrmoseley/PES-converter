/* Region model: one connected area of one thread colour, with smooth sampling
 * fields (sub-pixel edges), distance transforms and an A* travel planner. */
(function (E) {
  'use strict';
  const I = E.img;

  /** A float field over a region's crop, sampled in millimetres. */
  class Field {
    constructor(data, region) {
      this.data = data; this.w = region.w; this.h = region.h;
      this.ox = region.ox; this.oy = region.oy; this.res = region.res;
      this.inv = 1 / region.res;
    }
    value(X, Y) {
      return I.sample(this.data, this.w, this.h, X * this.inv - 0.5 - this.ox, Y * this.inv - 0.5 - this.oy);
    }
    inside(X, Y, thr = 0.5) { return this.value(X, Y) >= thr; }
    /** true if the straight segment a->b stays inside */
    lineInside(a, b, thr = 0.5) {
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(d / (this.res * 0.6)));
      for (let i = 1; i < n; i++) {
        const t = i / n;
        if (this.value(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) < thr) return false;
      }
      return true;
    }
  }

  class Region {
    constructor(opts) {
      Object.assign(this, opts);
      this.inv = 1 / this.res;
      this._fields = {};
    }
    toMM(i, j) { return [(this.ox + i + 0.5) * this.res, (this.oy + j + 0.5) * this.res]; }
    toLocal(X, Y) { return [X * this.inv - 0.5 - this.ox, Y * this.inv - 0.5 - this.oy]; }

    /** Main field: mask grown by `overlap` mm, then softly blurred for sub-pixel edges */
    get field() {
      if (!this._fields.main) {
        let m = this.mask;
        const grow = this.overlap * this.inv;
        if (grow > 0.05) {
          const inv = new Uint8Array(m.length);
          for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
          const dOut = I.edt(inv, this.w, this.h);
          m = new Uint8Array(m.length);
          // grow only into neighbouring stitched colours, never out into the background
          const into = this.growInto; // Set of labels sewn later (we tuck under them); null = all
          for (let i = 0; i < m.length; i++) {
            const nl = this.nbLabels[i];
            m[i] = this.mask[i] || (dOut[i] <= grow && nl && (!into || into.has(nl))) ? 1 : 0;
          }
        }
        this._fields.main = new Field(I.blurField(m, this.w, this.h, 0.9), this);
      }
      return this._fields.main;
    }
    /** Edge field without growth: the shape's own outline (used by satin) */
    get edgeField() {
      if (!this._fields.edge) this._fields.edge = new Field(I.blurField(this.mask, this.w, this.h, 0.9), this);
      return this._fields.edge;
    }
    get dtIn() {
      if (!this._dtIn) this._dtIn = I.edt(this.mask, this.w, this.h);
      return this._dtIn;
    }
    /** Field of the region shrunk by `inset` mm (null if nothing is left) */
    insetField(inset) {
      const key = 'in' + inset.toFixed(2);
      if (!(key in this._fields)) {
        const dt = this.dtIn, r = inset * this.inv + 0.5;
        const m = new Uint8Array(this.mask.length);
        let any = 0;
        for (let i = 0; i < m.length; i++) if (dt[i] > r) { m[i] = 1; any++; }
        this._fields[key] = any > 4 ? new Field(I.blurField(m, this.w, this.h, 0.9), this) : null;
      }
      return this._fields[key];
    }
    dtAt(X, Y) {
      const [x, y] = this.toLocal(X, Y);
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return 0;
      return this.dtIn[yi * this.w + xi] * this.res;
    }
    get maxWidth() {
      if (this._maxW === undefined) {
        let m = 0;
        const dt = this.dtIn;
        for (let i = 0; i < dt.length; i++) if (dt[i] > m) m = dt[i];
        this._maxW = 2 * m * this.res;
      }
      return this._maxW;
    }
    /** Closest boundary sample to point p (used for ordering) */
    nearestBoundary(p) {
      let best = null, bd = Infinity;
      for (const q of this.boundary) {
        const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      return { point: best, dist: Math.sqrt(bd) };
    }
  }

  /** Build Region objects for every connected component of every stitched label */
  function buildRegions(labels, w, h, res, include, overlap) {
    const { list } = I.components(labels, w, h, 8, true, (l) => l > 0 && include(l));
    const pad = Math.ceil(overlap / res) + 4;
    const regions = [];
    for (const c of list) {
      const ox = c.x0 - pad, oy = c.y0 - pad;
      const rw = c.x1 - c.x0 + 1 + 2 * pad, rh = c.y1 - c.y0 + 1 + 2 * pad;
      const mask = new Uint8Array(rw * rh);
      for (const i of c.pixels) {
        const x = i % w, y = (i / w) | 0;
        mask[(y - oy) * rw + (x - ox)] = 1;
      }
      // labels of other stitched colours around this region; which of them this region may grow
      // under is decided later from the sewing order (see Region.growInto)
      const nbLabels = new Uint8Array(rw * rh);
      for (let ly = 0; ly < rh; ly++) {
        const y = oy + ly;
        if (y < 0 || y >= h) continue;
        for (let lx = 0; lx < rw; lx++) {
          const x = ox + lx;
          if (x < 0 || x >= w) continue;
          const l = labels[y * w + x];
          if (l > 0 && l !== c.label && include(l)) nbLabels[ly * rw + lx] = l;
        }
      }
      // boundary samples for ordering
      const boundary = [];
      const bstep = Math.max(1, Math.floor(c.pixels.length / 1500));
      for (let k = 0; k < c.pixels.length; k += bstep) {
        const i = c.pixels[k];
        const x = i % w, y = (i / w) | 0;
        const lx = x - ox, ly = y - oy;
        if (!mask[ly * rw + lx - 1] || !mask[ly * rw + lx + 1] || !mask[(ly - 1) * rw + lx] || !mask[(ly + 1) * rw + lx]) {
          boundary.push([(x + 0.5) * res, (y + 0.5) * res]);
        }
      }
      if (!boundary.length) boundary.push([(c.x0 + 0.5) * res, (c.y0 + 0.5) * res]);
      regions.push(new Region({
        label: c.label, ox, oy, w: rw, h: rh, res, mask, nbLabels, overlap,
        areaPx: c.size, area: c.size * res * res, boundary,
      }));
    }
    return regions;
  }

  // ---------------------------------------------------------------- travel planner
  class MinHeap {
    constructor() { this.k = []; this.v = []; }
    push(key, val) {
      const k = this.k, v = this.v;
      let i = k.length; k.push(key); v.push(val);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= key) break;
        k[i] = k[p]; v[i] = v[p]; i = p;
      }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v;
      const top = v[0];
      const lk = k.pop(), lv = v.pop();
      if (k.length) {
        let i = 0;
        const n = k.length;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
    get size() { return this.k.length; }
  }

  /**
   * Travel planner for running stitches that move the needle inside a region.
   * Prefers routes through cells that have NOT been top-stitched yet, so the
   * travel stitches end up hidden underneath later fill.
   */
  class Traveler {
    constructor(region, field) {
      this.R = region; this.F = field;
      this.filledCost = (globalThis.Emb.travelFilledCost) || 3.0;
      this.g = Math.max(1, Math.round(0.45 / region.res));
      this.cell = this.g * region.res;
      this.gw = Math.ceil(region.w / this.g); this.gh = Math.ceil(region.h / this.g);
      const n = this.gw * this.gh;
      this.pass = new Uint8Array(n);
      this.filled = new Uint8Array(n);
      for (let cy = 0; cy < this.gh; cy++) for (let cx = 0; cx < this.gw; cx++) {
        const p = this.center(cx, cy);
        if (field.value(p[0], p[1]) >= 0.55) this.pass[cy * this.gw + cx] = 1;
      }
    }
    center(cx, cy) {
      const R = this.R;
      return [(R.ox + (cx + 0.5) * this.g) * R.res, (R.oy + (cy + 0.5) * this.g) * R.res];
    }
    cellOf(p) {
      const R = this.R;
      const cx = Math.floor((p[0] / R.res - R.ox) / this.g), cy = Math.floor((p[1] / R.res - R.oy) / this.g);
      return [cx, cy];
    }
    nearestPassable(p) {
      const [cx, cy] = this.cellOf(p);
      let best = -1, bd = Infinity;
      for (let r = 0; r <= 4 && best < 0; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= this.gw || y >= this.gh) continue;
          const i = y * this.gw + x;
          if (!this.pass[i]) continue;
          const c = this.center(x, y);
          const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      return best;
    }
    markLine(a, b) {
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(d / (this.cell * 0.5)));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const [cx, cy] = this.cellOf([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        if (cx >= 0 && cy >= 0 && cx < this.gw && cy < this.gh) this.filled[cy * this.gw + cx] = 1;
      }
    }
    /** Returns points from a (exclusive) to b (inclusive), or null when no inside route exists */
    route(a, b, maxStitch) {
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return [];
      if (this.F.lineInside(a, b, 0.45) && this.cheapLine(a, b)) return I.subdivide([a, b], maxStitch).slice(1);
      const s = this.nearestPassable(a), t = this.nearestPassable(b);
      if (s < 0 || t < 0) return null;
      const gw = this.gw, gh = this.gh;
      const tx = t % gw, ty = (t / gw) | 0;
      const gScore = new Float32Array(gw * gh).fill(Infinity);
      const from = new Int32Array(gw * gh).fill(-1);
      const closed = new Uint8Array(gw * gh);
      const heap = new MinHeap();
      const H = (i) => { const x = i % gw, y = (i / gw) | 0; const dx = Math.abs(x - tx), dy = Math.abs(y - ty); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
      gScore[s] = 0; heap.push(H(s), s);
      let found = false, iter = 0;
      const limit = gw * gh * 4;
      while (heap.size && iter++ < limit) {
        const i = heap.pop();
        if (closed[i]) continue;
        closed[i] = 1;
        if (i === t) { found = true; break; }
        const x = i % gw, y = (i / gw) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const j = ny * gw + nx;
          if (!this.pass[j] || closed[j]) continue;
          if (dx && dy && (!this.pass[y * gw + nx] || !this.pass[ny * gw + x])) continue; // no corner cutting
          const step = (dx && dy ? 1.414 : 1) * (this.filled[j] ? this.filledCost : 1.0);
          const ng = gScore[i] + step;
          if (ng < gScore[j]) { gScore[j] = ng; from[j] = i; heap.push(ng + H(j), j); }
        }
      }
      if (!found) return null;
      const cells = [];
      for (let i = t; i >= 0; i = from[i]) { cells.push(i); if (i === s) break; }
      cells.reverse();
      const pts = [a].concat(cells.map((i) => this.center(i % gw, (i / gw) | 0)), [b]);
      // string-pull: keep the route short while staying inside and off filled areas where possible
      const out = [a];
      let i = 0;
      while (i < pts.length - 1) {
        let j = pts.length - 1;
        while (j > i + 1 && !(this.F.lineInside(pts[i], pts[j], 0.5) && this.cheapLine(pts[i], pts[j]))) j--;
        out.push(pts[j]);
        i = j;
      }
      return I.subdivide(out, maxStitch).slice(1);
    }
    cheapLine(a, b) {
      // don't straighten a path across filled cells if the path itself avoided them
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(d / (this.cell * 0.7)));
      let hits = 0;
      const skip = d > 0 ? 0.6 / d : 1; // leaving / arriving on a just-sewn row edge is unavoidable
      for (let i = 1; i < n; i++) {
        const t = i / n;
        if (t < skip || t > 1 - skip) continue;
        const [cx, cy] = this.cellOf([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        if (cx >= 0 && cy >= 0 && cx < this.gw && cy < this.gh && this.filled[cy * this.gw + cx]) hits++;
      }
      return hits === 0;
    }
  }

  E.Field = Field;
  E.Region = Region;
  E.buildRegions = buildRegions;
  E.Traveler = Traveler;
})(globalThis.Emb = globalThis.Emb || {});
