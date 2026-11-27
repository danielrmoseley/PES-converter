/* Raster processing: background detection, colour quantisation, label cleanup,
 * connected components, distance transforms, smoothing, contours, skeletons. */
(function (E) {
  'use strict';

  // ---------------------------------------------------------------- colour
  function toLab(img) {
    const { data, width, height } = img;
    const n = width * height;
    const lab = new Float32Array(n * 3);
    const opaque = new Uint8Array(n);
    const cache = new Map();
    for (let i = 0; i < n; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
      opaque[i] = a >= 128 ? 1 : 0;
      const key = (r << 16) | (g << 8) | b;
      let v = cache.get(key);
      if (!v) { v = E.rgbToLab(r, g, b); if (cache.size < 200000) cache.set(key, v); }
      lab[i * 3] = v[0]; lab[i * 3 + 1] = v[1]; lab[i * 3 + 2] = v[2];
    }
    return { lab, opaque, width, height };
  }

  /** Looks at the image border. Returns {transparent:true} | {lab:[..]} | null */
  function detectBackground(L) {
    const { lab, opaque, width: w, height: h } = L;
    const idx = [];
    const stepX = Math.max(1, Math.floor(w / 120)), stepY = Math.max(1, Math.floor(h / 120));
    for (let x = 0; x < w; x += stepX) { idx.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y += stepY) { idx.push(y * w, y * w + w - 1); }
    let transparent = 0;
    const pts = [];
    for (const i of idx) {
      if (!opaque[i]) transparent++;
      else pts.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]);
    }
    if (transparent > idx.length * 0.4) return { transparent: true };
    if (!pts.length) return null;
    // mode-seeking: the border colour with most neighbours within dE 10
    const T = 100;
    let best = -1, bestCount = 0;
    for (let i = 0; i < pts.length; i++) {
      let c = 0;
      for (let j = 0; j < pts.length; j++) if (E.labDist2(pts[i], pts[j]) < T) c++;
      if (c > bestCount) { bestCount = c; best = i; }
    }
    if (bestCount < idx.length * 0.35) return null;
    const m = [0, 0, 0];
    let k = 0;
    for (const p of pts) if (E.labDist2(p, pts[best]) < T) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; k++; }
    return { lab: [m[0] / k, m[1] / k, m[2] / k] };
  }

  /** Bounding box (px) of non-background content, or null */
  function contentBounds(L, bg) {
    const { lab, opaque, width: w, height: h } = L;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    const T = 15 * 15;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!opaque[i]) continue;
      if (bg && bg.lab) {
        const p = [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
        if (E.labDist2(p, bg.lab) < T) continue;
      }
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    return { x0, y0, x1, y1 };
  }

  // Simple deterministic PRNG so results are reproducible
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  /**
   * K-means in Lab with optional pinned background centre.
   * Returns { labels: Uint8Array (0 = background / not stitched), colors: [{lab,rgb,thread,count}] }
   * colors[0] is a placeholder for background.
   */
  function quantize(L, opts) {
    const { lab, opaque, width: w, height: h } = L;
    const n = w * h;
    const k = Math.max(1, Math.min(16, opts.colors | 0));
    const bg = opts.removeBackground ? detectBackground(L) : null;
    const pinned = bg && bg.lab ? bg.lab : null;

    // sample
    const sampleIdx = [];
    const target = 60000;
    const stride = Math.max(1, Math.floor(n / target));
    const rand = rng(12345);
    for (let i = Math.floor(rand() * stride); i < n; i += stride) if (opaque[i]) sampleIdx.push(i);
    const S = sampleIdx.length;
    const samp = new Float32Array(S * 3);
    for (let s = 0; s < S; s++) {
      const i = sampleIdx[s];
      samp[s * 3] = lab[i * 3]; samp[s * 3 + 1] = lab[i * 3 + 1]; samp[s * 3 + 2] = lab[i * 3 + 2];
    }

    // k-means++ init
    const centers = [];
    if (pinned) centers.push(pinned.slice());
    const dmin = new Float32Array(S).fill(Infinity);
    const upd = (c) => {
      for (let s = 0; s < S; s++) {
        const dl = samp[s * 3] - c[0], da = samp[s * 3 + 1] - c[1], db = samp[s * 3 + 2] - c[2];
        const d = dl * dl + da * da + db * db;
        if (d < dmin[s]) dmin[s] = d;
      }
    };
    if (pinned) upd(pinned);
    const total = k + (pinned ? 1 : 0);
    while (centers.length < total && S > 0) {
      let sum = 0;
      if (!centers.length) { const s = Math.floor(rand() * S); centers.push([samp[s * 3], samp[s * 3 + 1], samp[s * 3 + 2]]); upd(centers[0]); continue; }
      for (let s = 0; s < S; s++) sum += dmin[s];
      if (sum <= 1e-6) break;
      let r = rand() * sum, s = 0;
      for (; s < S - 1; s++) { r -= dmin[s]; if (r <= 0) break; }
      const c = [samp[s * 3], samp[s * 3 + 1], samp[s * 3 + 2]];
      centers.push(c); upd(c);
    }

    const K = centers.length;
    const assign = new Int32Array(S);
    for (let iter = 0; iter < 20; iter++) {
      const acc = new Float64Array(K * 4);
      let changed = 0;
      for (let s = 0; s < S; s++) {
        let bi = 0, bd = Infinity;
        for (let c = 0; c < K; c++) {
          const C = centers[c];
          const dl = samp[s * 3] - C[0], da = samp[s * 3 + 1] - C[1], db = samp[s * 3 + 2] - C[2];
          const d = dl * dl + da * da + db * db;
          if (d < bd) { bd = d; bi = c; }
        }
        if (assign[s] !== bi) { changed++; assign[s] = bi; }
        acc[bi * 4] += samp[s * 3]; acc[bi * 4 + 1] += samp[s * 3 + 1]; acc[bi * 4 + 2] += samp[s * 3 + 2]; acc[bi * 4 + 3]++;
      }
      for (let c = 0; c < K; c++) {
        if (pinned && c === 0) continue;
        const cnt = acc[c * 4 + 3];
        if (cnt > 0) centers[c] = [acc[c * 4] / cnt, acc[c * 4 + 1] / cnt, acc[c * 4 + 2] / cnt];
      }
      if (iter > 2 && changed < S * 0.001) break;
    }

    // Map k-means centres -> output colours (merge near-identical / same thread)
    const used = new Set();
    const outColors = [null]; // 0 = background
    const centerMap = new Int32Array(K);
    const mergeT = 7 * 7;
    for (let c = 0; c < K; c++) {
      if (pinned && c === 0) { centerMap[c] = 0; continue; }
      const C = centers[c];
      let target = -1;
      if (opts.snapToThreads) {
        const t = E.nearestThread(C);
        for (let j = 1; j < outColors.length; j++) if (outColors[j].thread.index === t.index) target = j;
        if (target < 0) { outColors.push({ lab: t.lab, rgb: t.rgb.slice(), thread: t, srcLab: C }); target = outColors.length - 1; }
      } else {
        for (let j = 1; j < outColors.length; j++) if (E.labDist2(outColors[j].srcLab, C) < mergeT) target = j;
        if (target < 0) {
          const rgb = E.labToRgb(C[0], C[1], C[2]);
          outColors.push({ lab: C, rgb, thread: E.nearestThread(C), srcLab: C });
          target = outColors.length - 1;
        }
      }
      centerMap[c] = target;
      used.add(target);
    }

    const labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!opaque[i]) { labels[i] = 0; continue; }
      let bi = 0, bd = Infinity;
      const l0 = lab[i * 3], l1 = lab[i * 3 + 1], l2 = lab[i * 3 + 2];
      for (let c = 0; c < K; c++) {
        const C = centers[c];
        const d = (l0 - C[0]) ** 2 + (l1 - C[1]) ** 2 + (l2 - C[2]) ** 2;
        if (d < bd) { bd = d; bi = c; }
      }
      labels[i] = centerMap[bi];
    }
    return { labels, colors: outColors, background: bg };
  }

  // ---------------------------------------------------------------- blend (anti-alias) colours
  /**
   * Anti-aliasing and JPEG blur create thin bands of in-between colour along every edge
   * (e.g. dark red between red and a black outline). K-means happily gives those bands their
   * own cluster, which would turn into hundreds of tiny satin slivers and trims.
   *
   * A cluster is dissolved when it is
   *   - spatially thin: most of its pixels are within 2px of a different colour, and
   *   - a blend in colour: it lies between two neighbouring colours in Lab space,
   *     or is a close shade of one neighbour.
   * Its pixels are reassigned individually to the nearest real neighbour, sharpening the edge.
   *
   * labOf[label] = representative Lab colour (labOf[0] = background colour or null).
   * Returns the number of colours removed.
   */
  function mergeBlendColors(labels, w, h, pixLab, labOf, opts = {}) {
    const K = labOf.length;
    const R = 2;
    const minThin = opts.minThin || 0.6;
    const alive = new Uint8Array(K).fill(1);
    let removed = 0;
    for (let iter = 0; iter < K; iter++) {
      const count = new Float64Array(K), near = new Float64Array(K), pair = new Float64Array(K * K);
      const seen = new Int32Array(K).fill(-1);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, l = labels[i];
        count[l]++;
        let any = false;
        for (let dy = -R; dy <= R; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -R; dx <= R; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const o = labels[yy * w + xx];
            if (o !== l && seen[o] !== i) { seen[o] = i; pair[l * K + o]++; any = true; }
          }
        }
        if (any) near[l]++;
      }
      let best = null;
      for (let T = 1; T < K; T++) {
        if (!alive[T] || !count[T] || !labOf[T]) continue;
        const thin = near[T] / count[T];
        if (thin < minThin) continue;
        const nbs = [];
        for (let o = 0; o < K; o++) if (o !== T && pair[T * K + o] > 0 && labOf[o] && alive[o]) nbs.push(o);
        nbs.sort((a, b) => pair[T * K + b] - pair[T * K + a]);
        const top = nbs.slice(0, 4);
        const c = labOf[T];
        let cand = null;
        // between two neighbours?
        for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) {
          const A = labOf[top[a]], Bc = labOf[top[b]];
          const ab = [Bc[0] - A[0], Bc[1] - A[1], Bc[2] - A[2]];
          const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
          if (L2 < 1) continue;
          const t = ((c[0] - A[0]) * ab[0] + (c[1] - A[1]) * ab[1] + (c[2] - A[2]) * ab[2]) / L2;
          if (t < 0.05 || t > 0.95) continue;
          const d = Math.sqrt((c[0] - A[0] - t * ab[0]) ** 2 + (c[1] - A[1] - t * ab[1]) ** 2 + (c[2] - A[2] - t * ab[2]) ** 2);
          if (d <= Math.max(10, 0.3 * Math.sqrt(L2)) && (!cand || d < cand.d)) cand = { d, into: [top[a], top[b]] };
        }
        // or just a slightly different shade of one neighbour?
        for (const o of top) {
          const d = Math.sqrt(E.labDist2(c, labOf[o]));
          if (d < 20 && (!cand || d < cand.d)) cand = { d, into: [o] };
        }
        if (cand && (!best || thin > best.thin)) best = Object.assign(cand, { T, thin });
      }
      if (!best) break;
      // reassign each pixel of T to its nearest target colour
      for (let i = 0; i < w * h; i++) {
        if (labels[i] !== best.T) continue;
        let to = best.into[0];
        if (best.into.length > 1) {
          const p = [pixLab[i * 3], pixLab[i * 3 + 1], pixLab[i * 3 + 2]];
          let bd = Infinity;
          for (const o of best.into) { const d = E.labDist2(p, labOf[o]); if (d < bd) { bd = d; to = o; } }
        }
        labels[i] = to;
      }
      alive[best.T] = 0;
      removed++;
    }
    return removed;
  }

  // ---------------------------------------------------------------- cleanup
  /** 3x3 majority (mode) filter on a label image */
  function majorityFilter(labels, w, h, passes) {
    let src = labels, dst = new Uint8Array(labels.length);
    const counts = new Uint16Array(256);
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const touched = [];
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= w) continue;
              const l = src[yy * w + xx];
              if (counts[l]++ === 0) touched.push(l);
            }
          }
          let best = src[i], bc = counts[src[i]];
          for (const l of touched) { if (counts[l] > bc) { bc = counts[l]; best = l; } counts[l] = 0; }
          dst[i] = bc >= 5 ? best : src[i];
        }
      }
      const t = src === labels ? new Uint8Array(labels.length) : src;
      src = dst; dst = t;
    }
    if (src !== labels) labels.set(src);
    return labels;
  }

  function boxSizesForGauss(sigma, n) {
    const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    const sizes = [];
    for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
    return sizes;
  }

  // running-sum box blur, clamp-to-edge; horizontal then vertical
  function boxBlur(src, dst, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let acc = src[o] * (r + 1);
      for (let k = 1; k <= r; k++) acc += src[o + Math.min(k, w - 1)];
      for (let x = 0; x < w; x++) {
        dst[o + x] = acc * inv;
        acc += src[o + Math.min(x + r + 1, w - 1)] - src[o + Math.max(x - r, 0)];
      }
    }
    const col = new Float32Array(h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) col[y] = dst[y * w + x];
      let acc = col[0] * (r + 1);
      for (let k = 1; k <= r; k++) acc += col[Math.min(k, h - 1)];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = acc * inv;
        acc += col[Math.min(y + r + 1, h - 1)] - col[Math.max(y - r, 0)];
      }
    }
  }

  /**
   * Edge smoothing that keeps thin lines: every colour's mask is Gaussian-blurred and each pixel
   * takes the colour with the highest blurred weight. Boundaries become smooth curves at the
   * scale sigmaPx, while a 2-3px outline still wins at its own centre line.
   */
  function smoothLabels(labels, w, h, sigmaPx) {
    if (sigmaPx < 0.35) return labels;
    const n = w * h;
    const present = new Set(labels);
    const sizes = boxSizesForGauss(sigmaPx, 3);
    const best = new Float32Array(n).fill(-1);
    const out = new Uint8Array(labels);
    const a = new Float32Array(n), b = new Float32Array(n);
    // thin features (outlines, strokes) are protected: blurring would erode them and could open
    // gaps in an outline, changing what is enclosed. Their edges are smoothed later by the satin.
    const thin = new Uint8Array(n);
    const r = Math.max(1, Math.round(sigmaPx * 1.5));
    const thinLimit = sigmaPx * 1.6 + 0.5;
    const tmp = new Float32Array(n);
    for (const l of present) {
      const m = new Uint8Array(n);
      for (let i = 0; i < n; i++) m[i] = labels[i] === l ? 1 : 0;
      const dt = edt(m, w, h);
      // local half-width = max distance-to-edge in a (2r+1)^2 window (separable max filter)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let mx = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (dt[y * w + k] > mx) mx = dt[y * w + k];
        tmp[y * w + x] = mx;
      }
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
        if (!m[y * w + x]) continue;
        let mx = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (tmp[k * w + x] > mx) mx = tmp[k * w + x];
        if (mx <= thinLimit) thin[y * w + x] = 1;
      }
    }
    for (const l of present) {
      for (let i = 0; i < n; i++) a[i] = labels[i] === l ? 1 : 0;
      let src = a, dst = b;
      for (const s of sizes) { boxBlur(src, dst, w, h, (s - 1) >> 1); const t = src; src = dst; dst = t; }
      for (let i = 0; i < n; i++) {
        // tiny bias towards the current label so flat areas never flip
        const v = src[i] + (labels[i] === l ? 1e-3 : 0);
        if (v > best[i]) { best[i] = v; out[i] = l; }
      }
    }
    // keep thin features intact, and never let smoothing paint over them
    for (let i = 0; i < n; i++) if (thin[i]) out[i] = labels[i];
    labels.set(out);
    return labels;
  }

  /** Connected components on a label image. conn = 4 or 8. Returns {comp:Int32Array, list:[{label,size,pixels?}]} */
  function components(labels, w, h, conn, keepPixels, filter) {
    const comp = new Int32Array(w * h).fill(-1);
    const list = [];
    const stack = new Int32Array(w * h);
    for (let s = 0; s < w * h; s++) {
      if (comp[s] >= 0) continue;
      const lab = labels[s];
      if (filter && !filter(lab)) continue;
      const id = list.length;
      let sp = 0, size = 0;
      stack[sp++] = s; comp[s] = id;
      const pixels = keepPixels ? [] : null;
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      while (sp) {
        const i = stack[--sp];
        size++;
        if (pixels) pixels.push(i);
        const x = i % w, y = (i / w) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            if (conn === 4 && dx && dy) continue;
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (comp[j] < 0 && labels[j] === lab) { comp[j] = id; stack[sp++] = j; }
          }
        }
      }
      list.push({ label: lab, size, pixels, x0, y0, x1, y1 });
    }
    return { comp, list };
  }

  /** Merge components smaller than minPx into their most common neighbouring label */
  function removeSmallRegions(labels, w, h, minPx) {
    for (let pass = 0; pass < 3; pass++) {
      const { comp, list } = components(labels, w, h, 4, true);
      const order = list.map((c, i) => i).filter((i) => list[i].size < minPx).sort((a, b) => list[a].size - list[b].size);
      if (!order.length) return labels;
      for (const id of order) {
        const c = list[id];
        const votes = new Map();
        for (const i of c.pixels) {
          const x = i % w, y = (i / w) | 0;
          const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
          for (const j of nb) {
            if (j < 0) continue;
            const l = labels[j];
            if (l !== c.label) votes.set(l, (votes.get(l) || 0) + 1);
          }
        }
        let best = -1, bv = 0;
        for (const [l, v] of votes) if (v > bv) { bv = v; best = l; }
        if (best >= 0) for (const i of c.pixels) labels[i] = best;
      }
    }
    return labels;
  }

  // ---------------------------------------------------------------- distance transform
  // Felzenszwalb & Huttenlocher exact squared EDT
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }

  /** Euclidean distance (px) from each pixel where mask!=0 to the nearest pixel where mask==0 */
  function edt(mask, w, h) {
    const INF = 1e20;
    const g = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = mask[i] ? INF : 0;
    const m = Math.max(w, h);
    const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = g[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = g[y * w + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
    }
    return out;
  }

  /** Separable Gaussian blur of a 0/1 mask into a float field */
  function blurField(mask, w, h, sigma) {
    const r = Math.max(1, Math.ceil(sigma * 2.5));
    const ker = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { ker[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += ker[i + r]; }
    for (let i = 0; i < ker.length; i++) ker[i] /= s;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) a += mask[y * w + xx] * ker[k + r]; }
      tmp[y * w + x] = a;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) a += tmp[yy * w + x] * ker[k + r]; }
      out[y * w + x] = a;
    }
    return out;
  }

  /** Bilinear sample of field at pixel-space coords (pixel centres at integer coords) */
  function sample(field, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
    const x0 = x | 0, y0 = y | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const fx = x - x0, fy = y - y0;
    const a = field[y0 * w + x0], b = field[y0 * w + x1], c = field[y1 * w + x0], d = field[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  // ---------------------------------------------------------------- contours (marching squares)
  /** Returns closed loops (arrays of [x,y] in pixel space) of the iso-line field==level */
  function contours(field, w, h, level) {
    const segs = [];
    const edgeKey = (x, y, dir) => ((y * (w + 2) + x) * 2 + dir); // dir 0: horizontal edge (x,y)-(x+1,y); 1: vertical (x,y)-(x,y+1)
    const pts = new Map();
    const interp = (key, x0, y0, x1, y1, v0, v1) => {
      if (!pts.has(key)) {
        const t = (level - v0) / (v1 - v0 || 1e-9);
        pts.set(key, [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      }
      return key;
    };
    const val = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : field[y * w + x]);
    for (let y = -1; y < h; y++) {
      for (let x = -1; x < w; x++) {
        const a = val(x, y), b = val(x + 1, y), c = val(x + 1, y + 1), d = val(x, y + 1);
        const idx = (a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (c >= level ? 2 : 0) | (d >= level ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const X = x + 1, Y = y + 1; // shift keys to be non-negative
        const top = () => interp(edgeKey(X, Y, 0), x, y, x + 1, y, a, b);
        const right = () => interp(edgeKey(X + 1, Y, 1), x + 1, y, x + 1, y + 1, b, c);
        const bottom = () => interp(edgeKey(X, Y + 1, 0), x, y + 1, x + 1, y + 1, d, c);
        const left = () => interp(edgeKey(X, Y, 1), x, y, x, y + 1, a, d);
        const center = (a + b + c + d) / 4;
        // segments oriented so that inside is on the left consistently
        switch (idx) {
          case 1: segs.push([left(), bottom()]); break;
          case 2: segs.push([bottom(), right()]); break;
          case 3: segs.push([left(), right()]); break;
          case 4: segs.push([right(), top()]); break;
          case 5: if (center >= level) { segs.push([left(), top()]); segs.push([right(), bottom()]); } else { segs.push([left(), bottom()]); segs.push([right(), top()]); } break;
          case 6: segs.push([bottom(), top()]); break;
          case 7: segs.push([left(), top()]); break;
          case 8: segs.push([top(), left()]); break;
          case 9: segs.push([top(), bottom()]); break;
          case 10: if (center >= level) { segs.push([top(), right()]); segs.push([bottom(), left()]); } else { segs.push([top(), left()]); segs.push([bottom(), right()]); } break;
          case 11: segs.push([top(), right()]); break;
          case 12: segs.push([right(), left()]); break;
          case 13: segs.push([right(), bottom()]); break;
          case 14: segs.push([bottom(), left()]); break;
        }
      }
    }
    // link segments: start key -> segment
    const byStart = new Map();
    segs.forEach((s, i) => { byStart.set(s[0], i); });
    const used = new Uint8Array(segs.length);
    const loops = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const loop = [];
      let j = i;
      while (j !== undefined && !used[j]) {
        used[j] = 1;
        loop.push(pts.get(segs[j][0]));
        j = byStart.get(segs[j][1]);
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  // ---------------------------------------------------------------- skeleton (Zhang-Suen)
  function skeletonize(mask, w, h) {
    const img = new Uint8Array(mask);
    const del = [];
    let changed = true;
    const P = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);
    while (changed) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        del.length = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue;
          const p2 = P(x, y - 1), p3 = P(x + 1, y - 1), p4 = P(x + 1, y), p5 = P(x + 1, y + 1),
            p6 = P(x, y + 1), p7 = P(x - 1, y + 1), p8 = P(x - 1, y), p9 = P(x - 1, y - 1);
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (step === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue; }
          else { if (p2 * p4 * p8 || p2 * p6 * p8) continue; }
          del.push(y * w + x);
        }
        if (del.length) { changed = true; for (const i of del) img[i] = 0; }
      }
    }
    return img;
  }

  /**
   * Circularity (4*pi*A / P^2) of a component's outer outline, holes ignored.
   * 1 = disc, ~0.5 = 4:1 ellipse, lower for slivers and ragged shapes.
   */
  function circularity(comp, w) { return shapeInfo(comp, w).circularity; }

  /** circularity of the outer outline + number of pixels inside it that belong to something else
   *  (e.g. a pupil inside an eye white) */
  function shapeInfo(comp, w) {
    const pad = 3;
    const cw = comp.x1 - comp.x0 + 1 + 2 * pad, ch = comp.y1 - comp.y0 + 1 + 2 * pad;
    const m = new Uint8Array(cw * ch);
    for (const i of comp.pixels) m[((i / w | 0) - comp.y0 + pad) * cw + (i % w) - comp.x0 + pad] = 1;
    // fill holes: anything not reachable from the crop border is inside
    const out = new Uint8Array(cw * ch), st = [0];
    out[0] = 1;
    while (st.length) {
      const j = st.pop(), x = j % cw, y = (j / cw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
        const k = yy * cw + xx;
        if (!out[k] && !m[k]) { out[k] = 1; st.push(k); }
      }
    }
    let inner = 0;
    for (let k = 0; k < m.length; k++) { if (!out[k] && !m[k]) inner++; m[k] = out[k] ? 0 : 1; }
    const loops = contours(blurField(m, cw, ch, 1.0), cw, ch, 0.5);
    if (!loops.length) return { circularity: 0, inner };
    let best = loops[0];
    for (const l of loops) if (polyLength(l) > polyLength(best)) best = l;
    let A = 0;
    for (let i = 0, j = best.length - 1; i < best.length; j = i++) A += best[j][0] * best[i][1] - best[i][0] * best[j][1];
    const P = polyLength(best.concat([best[0]]));
    return { circularity: P > 0 ? (4 * Math.PI * Math.abs(A / 2)) / (P * P) : 0, inner };
  }

  // ---------------------------------------------------------------- geometry helpers
  function rdp(points, eps, closed) {
    if (points.length < 3) return points.slice();
    if (closed) {
      // split the loop at the farthest point from the first point
      let far = 0, fd = -1;
      for (let i = 1; i < points.length; i++) {
        const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2;
        if (d > fd) { fd = d; far = i; }
      }
      const a = rdp(points.slice(0, far + 1), eps, false);
      const b = rdp(points.slice(far).concat([points[0]]), eps, false);
      return a.slice(0, -1).concat(b.slice(0, -1));
    }
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      const [ax, ay] = points[s], [bx, by] = points[e];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let md = -1, mi = -1;
      for (let i = s + 1; i < e; i++) {
        const [px, py] = points[i];
        let d;
        if (L2 < 1e-12) d = (px - ax) ** 2 + (py - ay) ** 2;
        else {
          let t = ((px - ax) * dx + (py - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
          d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
        }
        if (d > md) { md = d; mi = i; }
      }
      if (md > eps * eps) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
    }
    return points.filter((p, i) => keep[i]);
  }

  function polyLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return L;
  }

  /** Subdivide a polyline so no stitch exceeds maxLen, keeping vertices */
  function subdivide(pts, maxLen) {
    if (!pts.length) return [];
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.ceil(d / maxLen);
      for (let k = 1; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
      out.push(b);
    }
    return out;
  }

  /** Resample a polyline at (approximately) uniform spacing */
  function resample(pts, step) {
    const L = polyLength(pts);
    if (L < 1e-9) return [pts[0].slice()];
    const n = Math.max(1, Math.round(L / step));
    const ds = L / n;
    const out = [pts[0].slice()];
    let seg = 1, acc = 0, segLen = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    for (let k = 1; k < n; k++) {
      const target = k * ds;
      while (acc + segLen < target && seg < pts.length - 1) {
        acc += segLen; seg++;
        segLen = Math.hypot(pts[seg][0] - pts[seg - 1][0], pts[seg][1] - pts[seg - 1][1]);
      }
      const t = segLen > 0 ? (target - acc) / segLen : 0;
      const a = pts[seg - 1], b = pts[seg];
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out.push(pts[pts.length - 1].slice());
    return out;
  }

  E.img = {
    toLab, detectBackground, contentBounds, quantize, mergeBlendColors, majorityFilter, smoothLabels, components,
    removeSmallRegions, circularity, shapeInfo, edt, blurField, sample, contours, skeletonize,
    rdp, polyLength, subdivide, resample, rng,
  };
})(globalThis.Emb = globalThis.Emb || {});
