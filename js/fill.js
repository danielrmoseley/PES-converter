/* Tatami fill.
 *
 *  - The region is cut by parallel scan lines (rows) at the fill angle and row spacing.
 *  - Row segments are grouped into "sections": runs of rows where each segment overlaps
 *    exactly one segment in the next row (a boustrophedon cell decomposition). A section
 *    can be sewn back-and-forth without ever leaving the shape.
 *  - Needle penetrations sit on a global grid along the row direction; each row's grid is
 *    shifted by a stagger fraction, producing the even, brick-like tatami texture instead of
 *    visible channels.
 *  - Row ends are pushed out by the pull compensation so the fabric pulling in doesn't
 *    leave gaps at the edges.
 *  - Sections are visited greedily; the needle travels between them via the A* planner,
 *    preferring unstitched cells so travel ends up buried under later rows.
 */
(function (E) {
  'use strict';
  const I = E.img;

  const STAGGERS = {
    tatami: [0, 0.25, 0.5, 0.75],    // classic diagonal-line tatami
    brick: [0, 0.5],                   // brick offset
    twill: [0, 1 / 3, 2 / 3],          // steeper diagonal
    smooth: [0, 0.5, 0.25, 0.75],      // breaks up visible lines
    random: null,
  };

  function phaseFor(pattern, k) {
    const seq = STAGGERS[pattern];
    if (seq === undefined || seq === STAGGERS.tatami) return (((k % 4) + 4) % 4) / 4;
    if (seq === null) { // deterministic hash -> [0,1)
      let x = (k * 2654435761) >>> 0; x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
      return (x % 1000) / 1000;
    }
    return seq[((k % seq.length) + seq.length) % seq.length];
  }

  /** Scan the field into rows of inside segments. */
  function scanRows(field, region, angleDeg, spacing, minSeg) {
    const a = (angleDeg * Math.PI) / 180;
    const u = [Math.cos(a), Math.sin(a)], v = [-Math.sin(a), Math.cos(a)];
    const res = region.res;
    const X0 = region.ox * res, Y0 = region.oy * res, X1 = (region.ox + region.w) * res, Y1 = (region.oy + region.h) * res;
    const corners = [[X0, Y0], [X1, Y0], [X0, Y1], [X1, Y1]];
    let dmin = Infinity, dmax = -Infinity, tmin = Infinity, tmax = -Infinity;
    for (const c of corners) {
      const d = c[0] * v[0] + c[1] * v[1], t = c[0] * u[0] + c[1] * u[1];
      dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
    }
    const thr = 0.5;
    const step = res * 0.5;
    const val = (t, d) => field.value(t * u[0] + d * v[0], t * u[1] + d * v[1]);
    const refine = (tOut, tIn, d) => {
      for (let i = 0; i < 7; i++) {
        const m = (tOut + tIn) / 2;
        if (val(m, d) >= thr) tIn = m; else tOut = m;
      }
      return (tOut + tIn) / 2;
    };
    const rows = [];
    const k0 = Math.ceil(dmin / spacing), k1 = Math.floor(dmax / spacing);
    for (let k = k0; k <= k1; k++) {
      const d = k * spacing;
      const segs = [];
      let inside = false, start = 0, prevT = tmin;
      for (let t = tmin; t <= tmax + step; t += step) {
        const isIn = val(t, d) >= thr;
        if (isIn && !inside) { start = refine(prevT, t, d); inside = true; }
        else if (!isIn && inside) {
          const end = refine(t, prevT, d);
          if (end - start >= minSeg) segs.push({ t0: start, t1: end });
          inside = false;
        }
        prevT = t;
      }
      if (segs.length) rows.push({ k, d, segs });
    }
    return { rows, u, v, angle: angleDeg, spacing };
  }

  /** Boustrophedon decomposition of rows into sewable sections */
  function buildSections(scan, field) {
    const { rows, u, v } = scan;
    const P = (t, d) => [t * u[0] + d * v[0], t * u[1] + d * v[1]];
    const overlaps = (a, b) => a.t0 < b.t1 && b.t0 < a.t1;
    const sections = [];
    let prevRow = null;
    for (const row of rows) {
      const adjacent = prevRow && row.k === prevRow.k + 1;
      for (const s of row.segs) {
        s.row = row;
        let joined = false;
        if (adjacent) {
          const preds = prevRow.segs.filter((p) => overlaps(p, s));
          if (preds.length === 1) {
            const p = preds[0];
            const succ = row.segs.filter((q) => overlaps(p, q));
            if (succ.length === 1 && p.section && p.section.last === p) {
              // both possible row-to-row connections must stay inside the shape
              const okL = field.lineInside(P(p.t0, prevRow.d), P(s.t0, row.d), 0.3);
              const okR = field.lineInside(P(p.t1, prevRow.d), P(s.t1, row.d), 0.3);
              if (okL && okR) {
                p.section.segs.push(s); p.section.last = s; s.section = p.section; joined = true;
              }
            }
          }
        }
        if (!joined) {
          const sec = { segs: [s], last: s };
          s.section = sec;
          sections.push(sec);
        }
      }
      prevRow = row;
    }
    // smooth row ends along each section edge: removes pixel/JPEG raggedness but keeps
    // corners (large jumps between neighbouring rows are left alone)
    const lim = Math.max(0.8, scan.spacing * 3);
    for (const sec of sections) {
      const sg = sec.segs;
      if (sg.length < 3) continue;
      for (const key of ['t0', 't1']) {
        const orig = sg.map((q) => q[key]);
        for (let i = 1; i < sg.length - 1; i++) {
          const a = orig[i - 1], b = orig[i], c = orig[i + 1];
          if (Math.abs(a - b) < lim && Math.abs(c - b) < lim) sg[i][key] = (a + 2 * b + c) / 4;
        }
      }
    }
    return sections;
  }

  /** Points for one section given an entry choice */
  function sectionPoints(sec, scan, rev, side, p) {
    const { u, v } = scan;
    const P = (t, d) => [t * u[0] + d * v[0], t * u[1] + d * v[1]];
    const segs = rev ? sec.segs.slice().reverse() : sec.segs;
    const L = p.stitchLength, minS = p.minStitch, pc = p.pullComp;
    const out = [];
    for (let j = 0; j < segs.length; j++) {
      const s = segs[j], d = s.row.d;
      const dir = side ^ (j & 1);
      const a = dir === 0 ? s.t0 - pc : s.t1 + pc;
      const b = dir === 0 ? s.t1 + pc : s.t0 - pc;
      const pa = P(a, d);
      if (out.length) {
        const last = out[out.length - 1];
        const link = I.subdivide([last, pa], L).slice(1);
        for (const q of link) out.push(q);
      } else out.push(pa);
      const phase = p.stagger ? phaseFor(p.pattern, s.row.k) : 0;
      if (dir === 0) {
        let m = Math.ceil((a + minS) / L - phase);
        for (let t = (m + phase) * L; t < b - minS; t = (++m + phase) * L) out.push(P(t, d));
      } else {
        let m = Math.floor((a - minS) / L - phase);
        for (let t = (m + phase) * L; t > b + minS; t = (--m + phase) * L) out.push(P(t, d));
      }
      out.push(P(b, d));
    }
    return out;
  }

  function sectionEntries(sec, scan, pc) {
    const { u, v } = scan;
    const P = (t, d) => [t * u[0] + d * v[0], t * u[1] + d * v[1]];
    const f = sec.segs[0], l = sec.segs[sec.segs.length - 1];
    return [
      { rev: false, side: 0, p: P(f.t0 - pc, f.row.d) },
      { rev: false, side: 1, p: P(f.t1 + pc, f.row.d) },
      { rev: true, side: 0, p: P(l.t0 - pc, l.row.d) },
      { rev: true, side: 1, p: P(l.t1 + pc, l.row.d) },
    ];
  }

  /** Choose a fill angle: fewest sections (= fewest travels), biased to the requested angle */
  function chooseAngle(region, field, p) {
    if (!p.autoAngle) return p.angle;
    let best = p.angle, bestCost = Infinity;
    for (let k = 0; k < 8; k++) {
      const ang = p.angle + k * 22.5;
      const scan = scanRows(field, region, ang, Math.max(p.spacing, 0.8), p.minStitch);
      const secs = buildSections(scan, field).length;
      const dev = Math.min(k, 8 - k) * 22.5;
      const cost = secs + dev * 0.012;
      if (cost < bestCost) { bestCost = cost; best = ang; }
    }
    return best % 180;
  }

  /**
   * Stitch a set of rows. `ctx` carries the current run and travel helpers.
   * mark=true flags the rows as covered so later travel avoids running on top of them.
   */
  function stitchRows(ctx, field, region, angle, p, mark) {
    const scan = scanRows(field, region, angle, p.spacing, Math.max(0.3, p.minStitch * 0.8));
    const sections = buildSections(scan, field);
    const left = new Set(sections);
    while (left.size) {
      let best = null, bd = Infinity;
      for (const sec of left) {
        for (const e of sectionEntries(sec, scan, p.pullComp)) {
          const d = ctx.pen ? Math.hypot(e.p[0] - ctx.pen[0], e.p[1] - ctx.pen[1]) : 0;
          if (d < bd) { bd = d; best = { sec, e }; }
        }
      }
      left.delete(best.sec);
      const pts = sectionPoints(best.sec, scan, best.e.rev, best.e.side, p);
      ctx.moveTo(pts[0]);
      ctx.add(pts.slice(1));
      if (mark && ctx.traveler) {
        const { u, v } = scan;
        for (const s of best.sec.segs) {
          const d = s.row.d;
          ctx.traveler.markLine([s.t0 * u[0] + d * v[0], s.t0 * u[1] + d * v[1]], [s.t1 * u[0] + d * v[0], s.t1 * u[1] + d * v[1]]);
        }
      }
    }
    return sections.length;
  }

  /** Edge-walk underlay: running stitch around the inset outline */
  function edgeWalk(ctx, region, inset, len) {
    const f = region.insetField(inset);
    if (!f) return;
    const loops = I.contours(f.data, region.w, region.h, 0.5)
      .map((l) => l.map(([x, y]) => [(region.ox + x + 0.5) * region.res, (region.oy + y + 0.5) * region.res]));
    if (!loops.length) return;
    loops.sort((a, b) => I.polyLength(b) - I.polyLength(a));
    let loop = loops[0];
    if (I.polyLength(loop) < 4) return;
    loop = I.rdp(loop, 0.12, true);
    // start at the vertex nearest the pen
    let si = 0, sd = Infinity;
    if (ctx.pen) loop.forEach((q, i) => { const d = (q[0] - ctx.pen[0]) ** 2 + (q[1] - ctx.pen[1]) ** 2; if (d < sd) { sd = d; si = i; } });
    loop = loop.slice(si).concat(loop.slice(0, si), [loop[si]]);
    const pts = I.subdivide(loop, len);
    ctx.moveTo(pts[0]);
    ctx.add(pts.slice(1));
  }

  /** Full fill for one region: underlay + tatami top layer */
  function fillRegion(ctx, region, p) {
    const field = region.field;
    const angle = chooseAngle(region, field, p);
    const big = region.area > 12;
    ctx.kind = 'u';
    if (big && (p.underlay === 'edge' || p.underlay === 'both')) {
      edgeWalk(ctx, region, Math.max(0.4, p.underlayInset * 0.6), 2.2);
    }
    if (big && (p.underlay === 'fill' || p.underlay === 'both')) {
      const uf = region.insetField(p.underlayInset);
      if (uf) {
        stitchRows(ctx, uf, region, angle + 90, {
          spacing: p.underlaySpacing, stitchLength: 3.0, minStitch: 0.6, pullComp: 0,
          stagger: true, pattern: 'brick',
        }, false);
      }
    }
    ctx.kind = undefined;
    const sections = stitchRows(ctx, field, region, angle, p, true);
    return { angle, sections };
  }

  E.fill = { scanRows, buildSections, sectionPoints, fillRegion, stitchRows, chooseAngle, STAGGERS };
})(globalThis.Emb = globalThis.Emb || {});
