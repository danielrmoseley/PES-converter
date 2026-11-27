/* Brother PES (v1) writer: PES header + CEmbOne/CSewSeg blocks + PEC section
 * (colour list, stitch stream, monochrome thumbnails).
 *
 * Commands: { x, y (mm), c } where c: 0 STITCH, 1 JUMP, 3 COLOR_CHANGE, 4 END.
 * JUMP may carry { trim: true } to cut the thread before moving. */
(function (E) {
  'use strict';

  const STITCH = 0, JUMP = 1, COLOR = 3, END = 4;

  class Bytes {
    constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
    ensure(n) {
      if (this.len + n <= this.buf.length) return;
      let cap = this.buf.length * 2;
      while (cap < this.len + n) cap *= 2;
      const b = new Uint8Array(cap); b.set(this.buf.subarray(0, this.len)); this.buf = b;
    }
    u8(v) { this.ensure(1); this.buf[this.len++] = v & 0xff; }
    u16(v) { this.u8(v); this.u8(v >> 8); }
    u16be(v) { this.u8(v >> 8); this.u8(v); }
    u24(v) { this.u8(v); this.u8(v >> 8); this.u8(v >> 16); }
    u32(v) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); }
    f32(v) { const b = new Uint8Array(new Float32Array([v]).buffer); for (const x of b) this.u8(x); }
    str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0x7f); }
    bytes(a) { for (const x of a) this.u8(x); }
    patch16(pos, v) { this.buf[pos] = v & 0xff; this.buf[pos + 1] = (v >> 8) & 0xff; }
    patch24(pos, v) { this.buf[pos] = v & 0xff; this.buf[pos + 1] = (v >> 8) & 0xff; this.buf[pos + 2] = (v >> 16) & 0xff; }
    patch32(pos, v) { this.patch16(pos, v & 0xffff); this.patch16(pos + 2, (v >>> 16) & 0xffff); }
    result() { return this.buf.slice(0, this.len); }
  }

  /** Convert mm commands to integer 0.1mm units centred on the origin, splitting long moves */
  function toUnits(cmds) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of cmds) {
      if (s.c !== STITCH && s.c !== JUMP) continue;
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    }
    if (minX === Infinity) { minX = minY = maxX = maxY = 0; }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const out = [];
    let px = 0, py = 0;
    for (const s of cmds) {
      if (s.c === STITCH || s.c === JUMP) {
        const X = Math.round((s.x - cx) * 10), Y = Math.round((s.y - cy) * 10);
        const lim = s.c === JUMP ? 2000 : 120; // keep stitches <= 12mm, jumps within 12-bit range
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(X - px), Math.abs(Y - py)) / lim));
        for (let k = 1; k <= n; k++) {
          const x = k === n ? X : Math.round(px + ((X - px) * k) / n), y = k === n ? Y : Math.round(py + ((Y - py) * k) / n);
          out.push({ x, y, c: s.c, trim: s.trim && k === 1 });
        }
        px = X; py = Y;
      } else out.push({ c: s.c });
    }
    return out;
  }

  function boundsOf(u) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of u) {
      if (s.c !== STITCH && s.c !== JUMP) continue;
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    }
    if (minX === Infinity) return [0, 0, 0, 0];
    return [minX, minY, maxX, maxY];
  }

  // ------------------------------------------------------------ PEC
  function blankIcon() {
    const g = new Uint8Array(6 * 38);
    const row = (y, bytes) => g.set(bytes, y * 6);
    row(1, [0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f]);
    row(2, [0x08, 0, 0, 0, 0, 0x10]);
    row(3, [0x04, 0, 0, 0, 0, 0x20]);
    for (let y = 4; y <= 33; y++) row(y, [0x02, 0, 0, 0, 0, 0x40]);
    row(34, [0x04, 0, 0, 0, 0, 0x20]);
    row(35, [0x08, 0, 0, 0, 0, 0x10]);
    row(36, [0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f]);
    return g;
  }

  function drawScaled(bounds, points, g, buffer) {
    const [l, t, r, b] = bounds;
    const dw = r - l || 1, dh = b - t || 1;
    const gw = 48, gh = 38;
    const scale = Math.min((gw - buffer) / dw, (gh - buffer) / dh);
    const tx = -((r + l) / 2) * scale + gw / 2, ty = -((b + t) / 2) * scale + gh / 2;
    for (const p of points) {
      const x = Math.floor(p.x * scale + tx), y = Math.floor(p.y * scale + ty);
      if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      g[y * 6 + (x >> 3)] |= 1 << (x & 7);
    }
  }

  function writeValue(B, v, long, flag) {
    if (!long && v > -64 && v < 63) { B.u8(v & 0x7f); return; }
    v &= 0x0fff; v |= 0x8000; v |= (flag || 0) << 8;
    B.u8((v >> 8) & 0xff); B.u8(v & 0xff);
  }

  function pecEncode(B, u) {
    let colorTwo = true, jumping = true;
    let xx = 0, yy = 0;
    for (const s of u) {
      if (s.c === STITCH || s.c === JUMP) {
        const dx = s.x - xx, dy = s.y - yy;
        xx += dx; yy += dy;
        if (s.c === STITCH) {
          if (jumping) { if (dx !== 0 && dy !== 0) { writeValue(B, 0); writeValue(B, 0); } jumping = false; }
          writeValue(B, dx); writeValue(B, dy);
        } else {
          jumping = true;
          const flag = s.trim ? 0x20 : 0x10;
          writeValue(B, dx, true, flag); writeValue(B, dy, true, flag);
        }
      } else if (s.c === COLOR) {
        if (jumping) { writeValue(B, 0); writeValue(B, 0); jumping = false; }
        B.u8(0xfe); B.u8(0xb0); B.u8(colorTwo ? 2 : 1);
        colorTwo = !colorTwo;
      } else if (s.c === END) {
        B.u8(0xff);
        break;
      }
    }
  }

  function writePEC(B, u, colorIdx, name, bounds) {
    const nm = (name || 'Untitled').replace(/[^\x20-\x7e]/g, '_').slice(0, 8);
    B.str('LA:' + nm.padEnd(16, ' ') + '\r');
    B.bytes([0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0xff, 0x00]);
    B.u8(6); B.u8(38);
    B.bytes(new Array(12).fill(0x20));
    B.u8(colorIdx.length - 1);
    B.bytes(colorIdx);
    for (let i = colorIdx.length; i < 463; i++) B.u8(0x20);

    const start = B.len;
    B.u8(0); B.u8(0);
    B.u24(0);
    B.bytes([0x31, 0xff, 0xf0]);
    B.u16(Math.round(bounds[2] - bounds[0]));
    B.u16(Math.round(bounds[3] - bounds[1]));
    B.u16(0x1e0); B.u16(0x1b0);
    pecEncode(B, u);
    B.patch24(start + 2, B.len - start);

    // thumbnails: whole design, then one per colour block
    const all = blankIcon();
    const blocks = [[]];
    for (const s of u) {
      if (s.c === STITCH) blocks[blocks.length - 1].push(s);
      else if (s.c === COLOR) blocks.push([]);
    }
    for (const bl of blocks) drawScaled(bounds, bl, all, 4);
    B.bytes(all);
    for (const bl of blocks) {
      const g = blankIcon();
      drawScaled(bounds, bl, g, 5);
      B.bytes(g);
    }
  }

  // ------------------------------------------------------------ PES
  function writeSegments(B, u, colorIdx, adjX, adjY) {
    let section = 0, flag = -1, prevCode = -1, ci = 0;
    let code = colorIdx[0];
    const colorlog = [];
    let sx = 0, sy = 0;
    let i = 0;
    while (i < u.length) {
      const c = u[i].c;
      let j = i;
      while (j < u.length && u[j].c === c && c !== COLOR) j++;
      if (c === COLOR) { ci++; code = colorIdx[Math.min(ci, colorIdx.length - 1)]; i++; continue; }
      if (c !== STITCH && c !== JUMP) { i = j; continue; }
      const block = [];
      if (c === JUMP) {
        block.push([sx - adjX, sy - adjY]);
        block.push([u[j - 1].x - adjX, u[j - 1].y - adjY]);
      } else {
        for (let k = i; k < j; k++) { sx = u[k].x; sy = u[k].y; block.push([sx - adjX, sy - adjY]); }
      }
      if (flag !== -1) B.u16(0x8003);
      flag = c === JUMP ? 1 : 0;
      if (prevCode !== code) { colorlog.push([section, code]); prevCode = code; }
      B.u16(flag); B.u16(code); B.u16(block.length);
      for (const [x, y] of block) { B.u16(x & 0xffff); B.u16(y & 0xffff); }
      section++;
      i = j;
    }
    B.u16(colorlog.length);
    for (const [s, cc] of colorlog) { B.u16(s); B.u16(cc); }
    return section;
  }

  /**
   * @param cmds   command list in mm
   * @param colorIdx  PEC thread index (1..64) for each colour block, in order
   * @returns Uint8Array
   */
  function writePES(cmds, colorIdx, name) {
    const u = toUnits(cmds);
    if (!u.length || u[u.length - 1].c !== END) u.push({ c: END });
    const bounds = boundsOf(u);
    const B = new Bytes();
    B.str('#PES0001');
    const pecPtr = B.len;
    B.u32(0);
    const hasStitches = u.some((s) => s.c === STITCH);
    if (!hasStitches) {
      B.u16(1); B.u16(1); B.u16(0); B.u16(0); B.u16(0);
    } else {
      B.u16(1); B.u16(1); B.u16(1);
      B.u16(0xffff); B.u16(0x0000);
      // CEmbOne
      B.u16(7); B.str('CEmbOne');
      const [l, t, r, b] = bounds;
      const width = r - l, height = b - t;
      for (let k = 0; k < 8; k++) B.u16(0);
      B.f32(1); B.f32(0); B.f32(0); B.f32(1);
      B.f32(350 + 1300 / 2 - width / 2);
      B.f32(100 + height + 1800 / 2 - height / 2);
      B.u16(1); B.u16(0); B.u16(0);
      B.u16(Math.trunc(width)); B.u16(Math.trunc(height));
      B.bytes([0, 0, 0, 0, 0, 0, 0, 0]);
      const secPos = B.len;
      B.u16(0);
      B.u16(0xffff); B.u16(0x0000);
      // CSewSeg
      B.u16(7); B.str('CSewSeg');
      const sections = writeSegments(B, u, colorIdx, l, b);
      B.patch16(secPos, sections);
      B.u16(0); B.u16(0);
    }
    B.patch32(pecPtr, B.len);
    writePEC(B, u, colorIdx.length ? colorIdx : [20], name, bounds);
    return B.result();
  }

  E.pes = { writePES, STITCH, JUMP, COLOR, END };
})(globalThis.Emb = globalThis.Emb || {});
