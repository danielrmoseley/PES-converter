/* Satin columns for narrow shapes (strokes, outlines, lettering).
 *
 *  - The shape is thinned to a 1px skeleton (Zhang-Suen) and turned into a graph of
 *    endpoints/junctions and the centre-line paths between them. Corner spurs are pruned.
 *  - Each path is smoothed and resampled at the satin density. At every sample a ray is cast
 *    both ways along the local normal to find the two edges, so stitches always run straight
 *    across the stroke and rotate smoothly round curves. Leaf ends are extended to the tip
 *    so strokes taper naturally.
 *  - Inner-curve crowding is relieved with alternating short stitches.
 *  - The graph is sewn as a depth-first walk: going out along a path lays the underlay
 *    (centre walk or zig-zag), coming back lays the satin on top. The whole shape is therefore
 *    sewn in one continuous pass with no jumps and every underlay is covered.
 *  - If the skeleton doesn't cover the shape well, a single-direction scan satin is tried,
 *    and failing that the caller falls back to tatami fill.
 */
(function (E) {
  'use strict';
  const I = E.img;
  const N8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

  function buildGraph(region) {
    const { w, h } = region;
    const sk = I.skeletonize(region.mask, w, h);
    const S = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? sk[y * w + x] : 0);
    const nodeId = new Int32Array(w * h).fill(-1);
    const isNode = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!sk[y * w + x]) continue;
      let nb = 0, cn = 0;
      for (let k = 0; k < 8; k++) {
        const a = S(x + N8[k][0], y + N8[k][1]), b = S(x + N8[(k + 1) % 8][0], y + N8[(k + 1) % 8][1]);
        nb += a;
        if (!a && b) cn++;
      }
      if (nb <= 1 || cn >= 3) isNode[y * w + x] = 1;
    }
    const nodes = [];
    const newNode = (pixels) => {
      let sx = 0, sy = 0;
      for (const i of pixels) { sx += i % w; sy += (i / w) | 0; nodeId[i] = nodes.length; }
      const lx = sx / pixels.length, ly = sy / pixels.length;
      nodes.push({ id: nodes.length, pixels, pos: region.toMM(lx, ly) });
      return nodes.length - 1;
    };
    // cluster adjacent node pixels
    for (let i = 0; i < w * h; i++) {
      if (!isNode[i] || nodeId[i] >= 0) continue;
      const pix = [i], stack = [i];
      nodeId[i] = -2;
      while (stack.length) {
        const j = stack.pop(), x = j % w, y = (j / w) | 0;
        for (const [dx, dy] of N8) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (isNode[q] && nodeId[q] === -1) { nodeId[q] = -2; pix.push(q); stack.push(q); }
        }
      }
      newNode(pix);
    }
    const visited = new Uint8Array(w * h);
    const edges = [];
    const trace = (n, q, r) => {
      const path = [r];
      visited[r] = 1;
      let prev = q, cur = r, end = -1;
      for (;;) {
        const x = cur % w, y = (cur / w) | 0;
        let nodeHit = -1, next4 = -1, next8 = -1;
        for (let k = 0; k < 8; k++) {
          const xx = x + N8[k][0], yy = y + N8[k][1];
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const c = yy * w + xx;
          if (!sk[c] || c === prev) continue;
          if (isNode[c]) {
            if (nodeId[c] !== n || path.length >= 3) nodeHit = nodeId[c];
          } else if (!visited[c]) {
            if (k % 2 === 0) { if (next4 < 0) next4 = c; } else if (next8 < 0) next8 = c;
          }
        }
        if (nodeHit >= 0) { end = nodeHit; break; }
        const next = next4 >= 0 ? next4 : next8;
        if (next < 0) { isNode[cur] = 1; path.pop(); end = newNode([cur]); break; }
        visited[next] = 1; path.push(next); prev = cur; cur = next;
      }
      edges.push({ a: n, b: end, pix: path });
    };
    for (let n = 0; n < nodes.length; n++) {
      for (const q of nodes[n].pixels) {
        const x = q % w, y = (q / w) | 0;
        for (const [dx, dy] of N8) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const r = yy * w + xx;
          if (sk[r] && !isNode[r] && !visited[r]) trace(n, q, r);
        }
      }
    }
    // pure cycles (rings) have no node pixels yet
    for (let i = 0; i < w * h; i++) {
      if (sk[i] && !isNode[i] && !visited[i]) {
        isNode[i] = 1;
        const n = newNode([i]);
        const x = i % w, y = (i / w) | 0;
        for (const [dx, dy] of N8) {
          const r = (y + dy) * w + (x + dx);
          if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && sk[r] && !isNode[r] && !visited[r]) { trace(n, i, r); break; }
        }
      }
    }
    for (const e of edges) {
      e.path = [nodes[e.a].pos].concat(e.pix.map((i) => region.toMM(i % w, (i / w) | 0)), [nodes[e.b].pos]);
    }
    return { nodes, edges };
  }

  function degrees(g) {
    const deg = new Array(g.nodes.length).fill(0);
    for (const e of g.edges) { deg[e.a]++; deg[e.b]++; }
    return deg;
  }

  function pruneAndMerge(g, region) {
    for (let iter = 0; iter < 3; iter++) {
      let deg = degrees(g);
      let changed = false;
      if (g.edges.length > 1) {
        const keep = [];
        for (const e of g.edges) {
          const leafA = deg[e.a] === 1, leafB = deg[e.b] === 1;
          if (leafA !== leafB && e.a !== e.b) {
            // A branch is a thinning artefact (e.g. a spur into a corner) if it adds little shape
            // beyond the junction's own disc: len + r(tip) - r(junction) is small.
            const j = leafA ? e.b : e.a, tip = leafA ? e.a : e.b;
            const rJ = region.dtAt(g.nodes[j].pos[0], g.nodes[j].pos[1]);
            const rT = region.dtAt(g.nodes[tip].pos[0], g.nodes[tip].pos[1]);
            const gain = I.polyLength(e.path) + rT - rJ;
            if (gain < Math.max(0.35, rJ * 0.7)) { changed = true; deg[e.a]--; deg[e.b]--; continue; }
          }
          keep.push(e);
        }
        g.edges = keep;
      }
      // merge degree-2 nodes
      deg = degrees(g);
      for (let n = 0; n < g.nodes.length; n++) {
        if (deg[n] !== 2) continue;
        const inc = g.edges.filter((e) => e.a === n || e.b === n);
        if (inc.length !== 2) continue;
        let [e1, e2] = inc;
        const p1 = e1.b === n ? e1.path : e1.path.slice().reverse();
        const s1 = e1.b === n ? e1.a : e1.b;
        const p2 = e2.a === n ? e2.path : e2.path.slice().reverse();
        const s2 = e2.a === n ? e2.b : e2.a;
        const merged = { a: s1, b: s2, path: p1.concat(p2.slice(1)) };
        g.edges = g.edges.filter((e) => e !== e1 && e !== e2);
        g.edges.push(merged);
        deg[n] = 0;
        changed = true;
      }
      if (!changed) break;
    }
    return g;
  }

  function smoothPath(pts, iters) {
    let p = pts;
    for (let k = 0; k < iters; k++) {
      const q = [p[0]];
      for (let i = 1; i < p.length - 1; i++) {
        q.push([(p[i - 1][0] + 2 * p[i][0] + p[i + 1][0]) / 4, (p[i - 1][1] + 2 * p[i][1] + p[i + 1][1]) / 4]);
      }
      if (p.length > 1) q.push(p[p.length - 1]);
      p = q;
    }
    return p;
  }

  function ray(field, p, d, cap, res) {
    const step = res * 0.5;
    let s = 0;
    while (s < cap) {
      const ns = s + step;
      if (field.value(p[0] + d[0] * ns, p[1] + d[1] * ns) < 0.5) {
        let lo = s, hi = ns;
        for (let i = 0; i < 6; i++) {
          const m = (lo + hi) / 2;
          if (field.value(p[0] + d[0] * m, p[1] + d[1] * m) >= 0.5) lo = m; else hi = m;
        }
        return (lo + hi) / 2;
      }
      s = ns;
    }
    return cap;
  }

  /** Pull compensation per side for a satin stitch of the given width: fabric pulls wide columns
   *  in more than narrow ones, so compensation scales with width (as pro digitizing tools do). */
  function satinPC(p, width) {
    if (typeof p.satinPullComp === 'number') return p.satinPullComp;
    return Math.min(0.25, 0.08 + 0.04 * width) * (p.pullComp / 0.15 || 0);
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    return a[a.length >> 1];
  }

  /**
   * Split skeleton paths at sharp corners. A satin column can't turn a tight corner
   * without fanning, so (like a hand digitizer) we end one column at the corner and
   * start another, each extended to the outline so they overlap into a clean miter.
   */
  function splitCorners(g, region, maxTurnDeg) {
    const res = region.res, out = [];
    const cosMax = Math.cos((maxTurnDeg * Math.PI) / 180);
    for (const e of g.edges) {
      const P = e.path;
      const hw = median(P.filter((q, i) => i % 3 === 0).map((q) => region.dtAt(q[0], q[1])));
      const m = Math.max(3, Math.round((hw * 1.1) / res));
      if (P.length < 2 * m + 3) { out.push(e); continue; }
      const score = new Float32Array(P.length).fill(1);
      for (let i = m; i < P.length - m; i++) {
        const ax = P[i][0] - P[i - m][0], ay = P[i][1] - P[i - m][1];
        const bx = P[i + m][0] - P[i][0], by = P[i + m][1] - P[i][1];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la > 0 && lb > 0) score[i] = (ax * bx + ay * by) / (la * lb); // cos of turn
      }
      const cuts = [];
      for (let i = m; i < P.length - m; i++) {
        if (score[i] > cosMax) continue;
        let isMin = true;
        for (let j = Math.max(0, i - m); j <= Math.min(P.length - 1, i + m); j++) if (score[j] < score[i] || (score[j] === score[i] && j < i)) { isMin = false; break; }
        if (isMin && (!cuts.length || i - cuts[cuts.length - 1] >= m)) cuts.push(i);
      }
      if (!cuts.length) { out.push(e); continue; }
      let prevNode = e.a, prevIdx = 0;
      for (const ci of cuts) {
        const id = g.nodes.length;
        g.nodes.push({ id, pixels: [], pos: P[ci], corner: true });
        out.push({ a: prevNode, b: id, path: P.slice(prevIdx, ci + 1) });
        prevNode = id; prevIdx = ci;
      }
      out.push({ a: prevNode, b: e.b, path: P.slice(prevIdx) });
    }
    g.edges = out;
    return g;
  }

  /** Build the satin column (pairs of edge points) for one skeleton path.
   *  ends = { extA, extB } extend to the outline; { jA, jB } junction radius (mm) or 0 */
  function buildColumn(edge, region, p, ends) {
    const field = region.edgeField, res = region.res;
    const sp = p.satinSpacing;
    let pts = smoothPath(edge.path, 4);
    if (I.polyLength(pts) < sp) pts = [pts[0], pts[pts.length - 1]];
    let rs = I.resample(pts, sp);
    const tangentAt = (arr, i) => {
      const m = Math.max(1, Math.round(0.8 / sp));
      const a = arr[Math.max(0, i - m)], b = arr[Math.min(arr.length - 1, i + m)];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      return [dx / L, dy / L];
    };
    let extStart = 0;
    const extCap = new Map(); // tip-extension samples: cap rays by the stroke width where the tip starts
    const extend = (atStart) => {
      if (rs.length < 2) return;
      const i = atStart ? 0 : rs.length - 1;
      let t = tangentAt(rs, i);
      if (atStart) t = [-t[0], -t[1]];
      const o = rs[i];
      const D = ray(field, o, t, p.satinMax, res) - 0.1;
      const ext = [];
      let s = sp;
      for (; s < D - sp * 0.4; s += sp) ext.push([o[0] + t[0] * s, o[1] + t[1] * s]);
      // always finish with a stitch row just inside the stroke end so square ends are fully covered
      if (D > sp * 0.3) ext.push([o[0] + t[0] * D, o[1] + t[1] * D]);
      const capRef = region.dtAt(o[0], o[1]) * 1.4 + 2 * res + 0.1;
      for (const q of ext) extCap.set(q, capRef);
      if (atStart) { rs = ext.reverse().concat(rs); extStart = ext.length; } else rs = rs.concat(ext);
    };
    const coreLen = (rs.length - 1) * sp;
    if (ends.extA) extend(true);
    if (ends.extB) extend(false);
    // raw edge distances on both sides of the centre line
    const raw = [];
    for (let i = 0; i < rs.length; i++) {
      const c = rs[i];
      if (field.value(c[0], c[1]) < 0.5) continue;
      const t = tangentAt(rs, i);
      const n = [-t[1], t[0]];
      // near a stroke end the local distance-to-edge is measured to the END edge, which would make
      // square ends taper; extension samples use the stroke width from where the tip begins
      const cap = Math.min(p.satinMax * 0.85, extCap.has(c) ? extCap.get(c) : region.dtAt(c[0], c[1]) * 1.4 + 2 * res + 0.1);
      const along = (i - extStart) * sp; // distance from the core start
      // butt joints: a branch stops where it meets the continuous trunk of a junction
      if ((ends.trimA && along < ends.trimA) || (ends.trimB && along > coreLen - ends.trimB)) continue;
      raw.push({ c, n, s1: ray(field, c, n, cap, res), s2: ray(field, c, [-n[0], -n[1]], cap, res), along });
    }
    // Near junctions the rays run into the other branch; hold the width to the
    // column's own typical width there so columns overlap cleanly instead of fanning.
    const inJ = (q) => (ends.jA && q.along < ends.jA) || (ends.jB && q.along > coreLen - ends.jB);
    const interior = raw.filter((q) => !inJ(q));
    const base = interior.length >= 3 ? interior : raw;
    const ref1 = median(base.map((q) => q.s1)), ref2 = median(base.map((q) => q.s2));
    const W = 4;
    const s1s = raw.map((q) => q.s1), s2s = raw.map((q) => q.s2);
    const pc = p.pullComp;
    const pairs = [];
    const f1 = [], f2 = [];
    raw.forEach((q, i) => {
      let s1 = q.s1, s2 = q.s2;
      if (inJ(q)) { s1 = Math.min(s1, ref1 * 1.15 + 0.1); s2 = Math.min(s2, ref2 * 1.15 + 0.1); }
      // spike filter against local running median
      const lo = Math.max(0, i - W), hi = Math.min(raw.length, i + W + 1);
      f1.push(Math.min(s1, median(s1s.slice(lo, hi)) * 1.5 + 0.15));
      f2.push(Math.min(s2, median(s2s.slice(lo, hi)) * 1.5 + 0.15));
    });
    // smooth each edge along the column so outline wobble doesn't show in the satin edge
    const smoothArr = (a) => {
      const r = Math.max(1, Math.round((p.satinEdgeSmooth || 0.8) / sp));
      return a.map((v, i) => {
        let acc = 0, wsum = 0;
        for (let k = -r; k <= r; k++) {
          const j = i + k;
          if (j < 0 || j >= a.length) continue;
          const wt = r + 1 - Math.abs(k);
          acc += a[j] * wt; wsum += wt;
        }
        // never widen past the real edge by more than a hair (keeps tapers and tips honest)
        return Math.min(acc / wsum, v + 0.12);
      });
    };
    const g1 = smoothArr(f1), g2 = smoothArr(f2);
    raw.forEach((q, i) => {
      const s1 = g1[i], s2 = g2[i];
      const { c, n } = q;
      // keep a minimum column width so very thin strokes still sew cleanly
      const extra = Math.max(0, (p.satinMinWidth - (s1 + s2)) / 2);
      const pcw = satinPC(p, s1 + s2);
      const A = [c[0] - n[0] * (s2 + pcw + extra), c[1] - n[1] * (s2 + pcw + extra)];
      const B = [c[0] + n[0] * (s1 + pcw + extra), c[1] + n[1] * (s1 + pcw + extra)];
      pairs.push({ A, B, c, along: q.along, coreLen });
    });
    // short stitches on the inside of tight curves
    if (p.shortStitch) {
      for (let i = 1; i < pairs.length; i++) {
        if (i % 2 === 0) continue;
        for (const side of ['A', 'B']) {
          const d = Math.hypot(pairs[i][side][0] - pairs[i - 1][side][0], pairs[i][side][1] - pairs[i - 1][side][1]);
          if (d < sp * 0.5) {
            const q = pairs[i];
            q[side] = [q[side][0] + (q.c[0] - q[side][0]) * 0.35, q[side][1] + (q.c[1] - q[side][1]) * 0.35];
          }
        }
      }
    }
    return pairs;
  }

  function coverage(region, columns) {
    const { w, h } = region;
    const cov = new Uint8Array(w * h);
    const toL = (P) => region.toLocal(P[0], P[1]);
    for (const pairs of columns) {
      for (let i = 0; i + 1 < pairs.length; i++) {
        const q = [toL(pairs[i].A), toL(pairs[i].B), toL(pairs[i + 1].B), toL(pairs[i + 1].A)];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of q) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        if (x1 - x0 > 60 || y1 - y0 > 60) continue;
        for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
          for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(w - 1, Math.ceil(x1)); x++) {
            let inside = false;
            for (let a = 0, b = 3; a < 4; b = a++) {
              if ((q[a][1] > y) !== (q[b][1] > y) && x < ((q[b][0] - q[a][0]) * (y - q[a][1])) / (q[b][1] - q[a][1]) + q[a][0]) inside = !inside;
            }
            if (inside) cov[y * w + x] = 1;
          }
        }
      }
      // single pair columns: mark the stitch line
      if (pairs.length === 1) {
        const a = toL(pairs[0].A), b = toL(pairs[0].B);
        for (let t = 0; t <= 1; t += 0.05) {
          const x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t);
          if (x >= 0 && y >= 0 && x < w && y < h) cov[y * w + x] = 1;
        }
      }
    }
    let tot = 0, hit = 0;
    for (let i = 0; i < w * h; i++) if (region.mask[i]) { tot++; if (cov[i]) hit++; }
    return tot ? hit / tot : 0;
  }

  // ------------------------------------------------------------ emission helpers
  function satinStitches(pairs, maxLen) {
    // zig-zag: A0 B0 A1 B1 ... ; split overly long stitches (split satin)
    const out = [];
    let prev = null;
    for (let i = 0; i < pairs.length; i++) {
      const { A, B } = pairs[i];
      for (const P of [A, B]) {
        if (prev) {
          const d = Math.hypot(P[0] - prev[0], P[1] - prev[1]);
          if (d > maxLen) {
            const n = Math.ceil(d / maxLen);
            const off = (i % 2) * 0.5 / n;
            for (let k = 1; k < n; k++) {
              const t = Math.min(0.98, k / n + off);
              out.push([prev[0] + (P[0] - prev[0]) * t, prev[1] + (P[1] - prev[1]) * t]);
            }
          }
        }
        out.push(P);
        prev = P;
      }
    }
    return out;
  }

  function underlayFor(pairs, p) {
    if (!pairs.length) return [];
    const widths = pairs.map((q) => Math.hypot(q.B[0] - q.A[0], q.B[1] - q.A[1]));
    const avg = widths.reduce((a, b) => a + b, 0) / widths.length;
    const out = [];
    if (p.satinUnderlay === 'none') return out;
    if (p.satinUnderlay === 'zigzag' || (p.satinUnderlay === 'auto' && avg >= p.zigzagUnderlayMin)) {
      // zig-zag underlay, inset from the edges
      const k = Math.max(1, Math.round(p.zigzagUnderlaySpacing / p.satinSpacing));
      let side = 0;
      for (let i = 0; i < pairs.length; i += k) {
        const q = pairs[i];
        const P = side ? q.B : q.A;
        const hw = Math.hypot(P[0] - q.c[0], P[1] - q.c[1]);
        const keep = Math.max(0, hw - p.pullComp - 0.45);
        const f = hw > 1e-6 ? keep / hw : 0;
        out.push([q.c[0] + (P[0] - q.c[0]) * f, q.c[1] + (P[1] - q.c[1]) * f]);
        side ^= 1;
      }
    } else {
      // centre walk
      const centers = pairs.map((q) => q.c);
      const simplified = I.rdp(centers, 0.1, false);
      for (const q of I.subdivide(simplified, 2.0)) out.push(q);
    }
    return out;
  }

  /** Tree-walk emission: underlay on the way out, satin on the way back */
  function emitGraph(ctx, g, cols, p) {
    const adj = g.nodes.map(() => []);
    g.edges.forEach((e, i) => { adj[e.a].push(i); if (e.b !== e.a) adj[e.b].push(i); });
    const deg = degrees(g);
    let start = -1, bd = Infinity;
    for (let n = 0; n < g.nodes.length; n++) {
      if (!adj[n].length) continue;
      const pos = g.nodes[n].pos;
      const d = ctx.pen ? Math.hypot(pos[0] - ctx.pen[0], pos[1] - ctx.pen[1]) : 0;
      const score = d + (deg[n] === 1 ? 0 : 1000);
      if (score < bd) { bd = score; start = n; }
    }
    if (start < 0) return;
    const used = new Uint8Array(g.edges.length);
    const seen = new Uint8Array(g.nodes.length);
    seen[start] = 1;
    const maxLen = p.satinMaxStitch;
    const walk = (u) => {
      // visit long branches last so the final return is short
      const order = adj[u].slice().sort((x, y) => cols[x].length - cols[y].length);
      for (const ei of order) {
        if (used[ei]) continue;
        used[ei] = 1;
        const e = g.edges[ei];
        const v = e.a === u ? e.b : e.a;
        const fwd = e.a === u ? cols[ei] : cols[ei].slice().reverse();
        if (!fwd.length) { if (!seen[v]) { seen[v] = 1; walk(v); } continue; }
        const ul = underlayFor(fwd, p);
        if (ul.length) { ctx.moveTo(ul[0]); ctx.add(ul.slice(1), 'u'); }
        if (!seen[v]) { seen[v] = 1; walk(v); }
        const back = fwd.slice().reverse();
        const st = satinStitches(back, maxLen);
        ctx.moveTo(st[0]);
        ctx.add(st.slice(1));
      }
    };
    walk(start);
  }

  /** Fallback: straight satin across the narrowest direction (small blobs, bars) */
  function scanSatin(ctx, region, p) {
    const field = region.edgeField;
    let best = null;
    for (let k = 0; k < 12; k++) {
      const ang = k * 15;
      const scan = E.fill.scanRows(field, region, ang, Math.max(p.satinSpacing, 0.6), 0.2);
      const secs = E.fill.buildSections(scan, field);
      let maxLen = 0;
      for (const r of scan.rows) for (const s of r.segs) maxLen = Math.max(maxLen, s.t1 - s.t0);
      const cost = secs.length * 3 + maxLen;
      if (!best || cost < best.cost) best = { ang, cost, maxLen, n: secs.length };
    }
    if (!best || best.maxLen > p.satinMax * 1.25 || best.n > 3) return false;
    const scan = E.fill.scanRows(field, region, best.ang, p.satinSpacing, 0.1);
    const secs = E.fill.buildSections(scan, field);
    const { u, v } = scan;
    const P = (t, d) => [t * u[0] + d * v[0], t * u[1] + d * v[1]];
    const pc = p.pullComp;
    for (const sec of secs) {
      let pairs = sec.segs.map((s) => {
        const extra = Math.max(0, (p.satinMinWidth - (s.t1 - s.t0)) / 2);
        const pcw = satinPC(p, s.t1 - s.t0);
        return { A: P(s.t0 - pcw - extra, s.row.d), B: P(s.t1 + pcw + extra, s.row.d), c: P((s.t0 + s.t1) / 2, s.row.d) };
      });
      if (ctx.pen) {
        const f = pairs[0].c, l = pairs[pairs.length - 1].c;
        if (Math.hypot(l[0] - ctx.pen[0], l[1] - ctx.pen[1]) < Math.hypot(f[0] - ctx.pen[0], f[1] - ctx.pen[1])) pairs = pairs.reverse();
      }
      const ul = underlayFor(pairs, p);
      if (ul.length) { ctx.moveTo(ul[0]); ctx.add(ul.slice(1), 'u'); }
      const st = satinStitches(pairs.slice().reverse(), p.satinMaxStitch);
      ctx.moveTo(st[0]);
      ctx.add(st.slice(1));
    }
    return true;
  }

  /** Try to sew a region as satin. Returns 'skeleton' | 'scan' | false */
  /** Outward unit direction of edge ei leaving node n (measured ~1.5mm along the path) */
  function outDir(g, ei, n) {
    const e = g.edges[ei];
    const P = e.a === n ? e.path : e.path.slice().reverse();
    let k = 1, acc = 0;
    while (k < P.length - 1 && acc < 1.5) { acc += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]); k++; }
    const dx = P[k][0] - P[0][0], dy = P[k][1] - P[0][1], L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  }

  /**
   * Junction handling like a hand digitizer: at every junction the two branches that continue
   * most nearly straight become one continuous column passing through it (the trunk), and the
   * remaining branches butt into the trunk instead of all piling into the junction centre.
   * Returns { pass: Map(node -> [[ei,ej],...]), butt: Set('ei@node') }.
   */
  function junctionPlan(g, deg) {
    const pass = new Map(), butt = new Set();
    for (let n = 0; n < g.nodes.length; n++) {
      if (deg[n] < 3) continue;
      const inc = [];
      g.edges.forEach((e, i) => { if (e.a !== e.b && (e.a === n || e.b === n)) inc.push(i); });
      if (inc.length < 3) continue;
      const dirs = new Map(inc.map((i) => [i, outDir(g, i, n)]));
      const free = new Set(inc), pairs = [];
      for (;;) {
        let best = null, bd = -Math.cos((140 * Math.PI) / 180); // must continue within 40 degrees of straight
        for (const i of free) for (const j of free) {
          if (j <= i) continue;
          const a = dirs.get(i), b = dirs.get(j), dot = a[0] * b[0] + a[1] * b[1];
          if (dot < bd) { bd = dot; best = [i, j]; }
        }
        if (!best) break;
        pairs.push(best); free.delete(best[0]); free.delete(best[1]);
      }
      if (!pairs.length) continue;
      pass.set(n, pairs);
      for (const i of free) butt.add(i + '@' + n);
    }
    return { pass, butt };
  }

  /** Chain edges through pass-through junctions into continuous columns, then split back per edge */
  function buildColumns(g, region, p, deg) {
    const { pass, butt } = junctionPlan(g, deg);
    const partner = (ei, n) => {
      const prs = pass.get(n);
      if (!prs) return -1;
      for (const [a, b] of prs) { if (a === ei) return b; if (b === ei) return a; }
      return -1;
    };
    const other = (e, n) => (e.a === n ? e.b : e.a);
    const cols = new Array(g.edges.length);
    const done = new Uint8Array(g.edges.length);
    const jr = (n) => (deg[n] >= 3 ? region.dtAt(g.nodes[n].pos[0], g.nodes[n].pos[1]) * 1.3 + 0.3 : 0);
    const ext = (n) => deg[n] === 1 || !!g.nodes[n].corner;
    const trimAt = (ei, n) => (butt.has(ei + '@' + n) ? Math.max(0, region.dtAt(g.nodes[n].pos[0], g.nodes[n].pos[1]) - 0.3) : 0);
    for (let e0 = 0; e0 < g.edges.length; e0++) {
      if (done[e0]) continue;
      // walk backwards to the chain start
      let ei = e0, start = g.edges[e0].a, guard = 0;
      for (;;) {
        const q = partner(ei, start);
        if (q < 0 || q === e0 || guard++ > g.edges.length) break;
        start = other(g.edges[q], start); ei = q;
      }
      // walk forwards collecting oriented edges
      const chain = [];
      let n = start, cur = ei;
      while (cur >= 0 && !done[cur]) {
        done[cur] = 1;
        const e = g.edges[cur];
        const fwd = e.a === n;
        chain.push({ ei: cur, fwd, from: n });
        n = fwd ? e.b : e.a;
        cur = partner(cur, n);
      }
      const end = n;
      let path = [];
      const bounds = [];
      for (const c of chain) {
        const P = c.fwd ? g.edges[c.ei].path : g.edges[c.ei].path.slice().reverse();
        path = path.length ? path.concat(P.slice(1)) : P.slice();
        bounds.push(I.polyLength(path));
      }
      const first = chain[0], last = chain[chain.length - 1];
      const tA = trimAt(first.ei, start), tB = trimAt(last.ei, end);
      const pairs = buildColumn({ path }, region, p, {
        extA: ext(start) && !tA, extB: ext(end) && !tB,
        jA: tA ? 0 : jr(start), jB: tB ? 0 : jr(end), trimA: tA, trimB: tB,
      });
      // split back to the individual edges, each oriented a -> b as emitGraph expects
      const total = bounds[bounds.length - 1] || 1;
      let k = 0;
      chain.forEach((c, idx) => {
        const hi = bounds[idx] / total;
        const part = [];
        while (k < pairs.length) {
          const f = pairs[k].coreLen > 0 ? pairs[k].along / pairs[k].coreLen : 0;
          if (f > hi && idx < chain.length - 1) break;
          part.push(pairs[k++]);
        }
        cols[c.ei] = c.fwd ? part : part.reverse();
      });
    }
    return cols;
  }

  /**
   * A ring around another stitched feature (an eye white around a pupil, a rim around a button)
   * can only be satined radially, which looks like a starburst. If the ring is not thin compared
   * with the hole it surrounds, it is sewn as fill instead. Thin outlines drawn around a shape and
   * letter counters (holes showing fabric) are unaffected.
   */
  function ringAroundFeature(region) {
    const { w, h, mask, nbLabels } = region;
    const outside = new Uint8Array(w * h), st = [];
    for (let x = 0; x < w; x++) { st.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y++) { st.push(y * w, y * w + w - 1); }
    for (const i of st) outside[i] = 1;
    while (st.length) {
      const i = st.pop(), x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !outside[j] && !mask[j]) { outside[j] = 1; st.push(j); }
      }
    }
    // holes = background-of-mask pixels not reachable from the crop border
    const seen = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (mask[i] || outside[i] || seen[i]) continue;
      let area = 0, stitched = 0, cx = 0, cy = 0;
      const q = [i], edge = []; seen[i] = 1;
      while (q.length) {
        const k = q.pop(), x = k % w, y = (k / w) | 0;
        area++; cx += x; cy += y; if (nbLabels[k]) stitched++;
        let border = false;
        for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
          if (j >= 0 && mask[j]) border = true;
          if (j >= 0 && !mask[j] && !outside[j] && !seen[j]) { seen[j] = 1; q.push(j); }
        }
        if (border) edge.push(k);
      }
      if (area < 6 || stitched < area * 0.5 || !edge.length) continue;
      cx /= area; cy /= area;
      // ring thickness right around this hole: rays from the hole edge outward through the shape
      const lens = [];
      const step = Math.max(1, Math.floor(edge.length / 64));
      for (let e = 0; e < edge.length; e += step) {
        const x0 = edge[e] % w, y0 = (edge[e] / w) | 0;
        let dx = x0 - cx, dy = y0 - cy;
        const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        let t = 0.5;
        while (t < w + h) {
          const xx = Math.round(x0 + dx * t), yy = Math.round(y0 + dy * t);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          if (!mask[yy * w + xx] && t > 1) break;
          t += 0.5;
        }
        lens.push(t);
      }
      lens.sort((a, b) => a - b);
      const ring = lens[lens.length >> 1] * region.res;
      const rHole = Math.sqrt(area / Math.PI) * region.res;
      if (ring > 0.6 * rHole) return true;
    }
    return false;
  }

  function satinRegion(ctx, region, p) {
    if (ringAroundFeature(region)) return false;
    const g = splitCorners(pruneAndMerge(buildGraph(region), region), region, 55);
    if (g.edges.length && g.edges.length < 400) {
      const deg = degrees(g);
      const cols = buildColumns(g, region, p, deg);
      // A wide column bending tightly (a fat ring round a pupil, a thick crescent) makes satin fan
      // out into a starburst: stitches converge on the inside and splay on the outside.
      // Such shapes look much better as tatami fill.
      if (fanFraction(cols, p.satinSpacing) > (p.satinMaxFan || 0.6)) return false;
      const cov = coverage(region, cols);
      if (cov >= 0.8) {
        emitGraph(ctx, g, cols, p);
        return 'skeleton';
      }
    }
    return scanSatin(ctx, region, p) ? 'scan' : false;
  }

  /**
   * Fraction of satin samples whose stitches fan badly: curvature x half-width > 0.45 means the
   * outer edge spacing is > ~2.6x the inner edge spacing.
   */
  function fanFraction(cols, sp) {
    let bad = 0, total = 0;
    const m = Math.max(1, Math.round(0.8 / sp));
    for (const pairs of cols) {
      const n = pairs.length;
      if (n < 2 * m + 3) { total += n; continue; }
      const tan = pairs.map((q, i) => {
        const a = pairs[Math.max(0, i - m)].c, b = pairs[Math.min(n - 1, i + m)].c;
        return Math.atan2(b[1] - a[1], b[0] - a[0]);
      });
      for (let i = m; i < n - m; i++) {
        let dθ = tan[i + 1 < n ? i + 1 : i] - tan[i - 1];
        while (dθ > Math.PI) dθ -= 2 * Math.PI;
        while (dθ < -Math.PI) dθ += 2 * Math.PI;
        const a = pairs[i - 1].c, b = pairs[Math.min(n - 1, i + 1)].c;
        const ds = Math.hypot(b[0] - a[0], b[1] - a[1]) || sp;
        const hw = Math.hypot(pairs[i].B[0] - pairs[i].A[0], pairs[i].B[1] - pairs[i].A[1]) / 2;
        if ((Math.abs(dθ) / ds) * hw > 0.45) bad++;
        total++;
      }
    }
    return total ? bad / total : 0;
  }

  E.satin = { satinRegion, buildGraph, pruneAndMerge, splitCorners, buildColumn, coverage, fanFraction };
})(globalThis.Emb = globalThis.Emb || {});
