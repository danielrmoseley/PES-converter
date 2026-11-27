/* Canvas preview: realistic thread rendering, technical stitch-path view,
 * colour map and original image, with pan/zoom and stitch-out playback. */
(function (E) {
  'use strict';
  const { STITCH, JUMP, COLOR } = E.pes;

  function shade(rgb, f) { return `rgb(${rgb.map((v) => Math.round(v * f)).join(',')})`; }
  function tint(rgb, f) { return `rgb(${rgb.map((v) => Math.round(v + (255 - v) * f)).join(',')})`; }

  class Preview {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.mode = 'realistic';
      this.fabric = '#f4f1ea';
      this.cam = null;           // {s, x, y}: screen = (mm - x) * s
      this.upto = Infinity;
      this.showUnderlay = true;
      this.showJumps = true;
      this.design = null;        // {cmds, blocks:[{thread}], bounds}
      this.analysis = null;      // for colour map
      this.image = null;         // original (cropped) image canvas
      this._bind();
    }

    setDesign(cmds, blocks) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const segs = []; // per stitch command: index into blocks
      let b = 0, prev = null;
      for (const c of cmds) {
        if (c.c === COLOR) { b++; prev = null; continue; }
        if (c.c === STITCH || c.c === JUMP) {
          minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
        }
        c.b = b;
        c.prev = prev;
        if (c.c === STITCH || c.c === JUMP) prev = c;
      }
      this.design = { cmds, blocks, bounds: minX === Infinity ? [0, 0, 1, 1] : [minX, minY, maxX, maxY] };
      this.stitchTotal = cmds.length;
      this.draw();
    }

    setAnalysis(an, threadForLabel) { this.analysis = an; this.threadForLabel = threadForLabel; this._mapCanvas = null; }
    setImage(img) { this.image = img; }

    contentBounds() {
      if ((this.mode === 'realistic' || this.mode === 'paths') && this.design) return this.design.bounds;
      if (this.analysis) {
        const a = this.analysis;
        return [0, 0, a.width * a.res, a.height * a.res];
      }
      return [0, 0, 100, 100];
    }

    fit() {
      const r = this.canvas.getBoundingClientRect();
      const [x0, y0, x1, y1] = this.contentBounds();
      const s = Math.min(r.width / Math.max(1, x1 - x0), r.height / Math.max(1, y1 - y0)) * 0.9;
      this.cam = { s, x: (x0 + x1) / 2 - r.width / 2 / s, y: (y0 + y1) / 2 - r.height / 2 / s };
      this.draw();
    }

    _bind() {
      const cv = this.canvas;
      let drag = null;
      cv.addEventListener('wheel', (e) => {
        if (!this.cam) return;
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const wx = mx / this.cam.s + this.cam.x, wy = my / this.cam.s + this.cam.y;
        const f = Math.exp(-e.deltaY * 0.0015);
        this.cam.s = Math.max(0.5, Math.min(200, this.cam.s * f));
        this.cam.x = wx - mx / this.cam.s; this.cam.y = wy - my / this.cam.s;
        this.draw();
      }, { passive: false });
      let down = null;
      cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; down = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); cv.classList.add('dragging'); });
      cv.addEventListener('pointermove', (e) => {
        if (!drag || !this.cam) return;
        this.cam.x -= (e.clientX - drag.x) / this.cam.s; this.cam.y -= (e.clientY - drag.y) / this.cam.s;
        drag = { x: e.clientX, y: e.clientY };
        this.draw();
      });
      const end = () => { drag = null; cv.classList.remove('dragging'); };
      cv.addEventListener('pointerup', (e) => {
        // a click (no drag) picks the shape under the cursor
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4 && this.cam && this.onPick && this.mode !== 'original') {
          const r = cv.getBoundingClientRect();
          this.onPick((e.clientX - r.left) / this.cam.s + this.cam.x, (e.clientY - r.top) / this.cam.s + this.cam.y);
        }
        down = null;
        end();
      });
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('dblclick', () => this.fit());
      new ResizeObserver(() => { if (!this.cam) this.fit(); else this.draw(); }).observe(cv);
    }

    zoom(f) {
      if (!this.cam) return;
      const r = this.canvas.getBoundingClientRect();
      const cx = r.width / 2 / this.cam.s + this.cam.x, cy = r.height / 2 / this.cam.s + this.cam.y;
      this.cam.s = Math.max(0.5, Math.min(200, this.cam.s * f));
      this.cam.x = cx - r.width / 2 / this.cam.s; this.cam.y = cy - r.height / 2 / this.cam.s;
      this.draw();
    }

    draw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
    }

    _draw() {
      const cv = this.canvas, ctx = this.ctx;
      const r = cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = this.mode === 'original' ? '#e9e9e9' : this.fabric;
      ctx.fillRect(0, 0, W, H);
      if (!this.cam) { if (this.design || this.analysis) this.fit(); return; }
      const s = this.cam.s * dpr;
      ctx.setTransform(s, 0, 0, s, -this.cam.x * s, -this.cam.y * s);
      if (this.mode === 'realistic') this._drawRealistic(ctx, s);
      else if (this.mode === 'paths') this._drawPaths(ctx, s);
      else if (this.mode === 'map') this._drawMap(ctx);
      else if (this.mode === 'original') this._drawOriginal(ctx);
      this._drawHoop(ctx, s);
    }

    _drawHoop(ctx, s) {
      if (!this.hoop || !this.design || (this.mode !== 'realistic' && this.mode !== 'paths')) return;
      const [x0, y0, x1, y1] = this.design.bounds;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const [hw, hh] = this.hoop;
      ctx.save();
      ctx.setLineDash([4 / s * (window.devicePixelRatio || 1), 4 / s * (window.devicePixelRatio || 1)]);
      ctx.strokeStyle = 'rgba(60,60,60,0.45)';
      ctx.lineWidth = 1 / s * (window.devicePixelRatio || 1);
      ctx.strokeRect(cx - hw / 2, cy - hh / 2, hw, hh);
      ctx.restore();
    }

    _segments(filter) {
      // yields [blockIndex, kindGroup, from, to]
      const d = this.design;
      const out = [];
      const n = Math.min(d.cmds.length, this.upto);
      for (let i = 0; i < n; i++) {
        const c = d.cmds[i];
        if (c.c !== STITCH || !c.prev) continue;
        if (c.x === c.prev.x && c.y === c.prev.y) continue;
        if (filter && !filter(c)) continue;
        out.push(c);
      }
      return out;
    }

    _drawRealistic(ctx, s) {
      if (!this.design) return;
      const d = this.design;
      const w = 0.4; // thread width in mm
      const segs = this._segments();
      // group by block, then underlay/travel before top stitching
      const groups = new Map();
      for (const c of segs) {
        const key = c.b * 2 + (c.k ? 0 : 1);
        if (!groups.has(key)) groups.set(key, new Path2D());
        const p = groups.get(key);
        p.moveTo(c.prev.x, c.prev.y); p.lineTo(c.x, c.y);
      }
      const keys = [...groups.keys()].sort((a, b) => a - b);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const px = 1 / s * (window.devicePixelRatio || 1);
      for (const key of keys) {
        const blk = d.blocks[key >> 1];
        if (!blk) continue;
        const rgb = blk.thread.rgb;
        const path = groups.get(key);
        if (w * s < 1.5) {
          ctx.strokeStyle = shade(rgb, 0.92); ctx.lineWidth = Math.max(w, px); ctx.globalAlpha = 1;
          ctx.stroke(path);
          continue;
        }
        ctx.globalAlpha = 0.55; ctx.strokeStyle = shade(rgb, 0.45); ctx.lineWidth = w * 1.3; ctx.stroke(path);
        ctx.globalAlpha = 1; ctx.strokeStyle = shade(rgb, 0.9); ctx.lineWidth = w; ctx.stroke(path);
        ctx.globalAlpha = 0.65; ctx.strokeStyle = tint(rgb, 0.45); ctx.lineWidth = w * 0.32; ctx.stroke(path);
        ctx.globalAlpha = 1;
      }
      this._drawNeedle(ctx, s);
    }

    _drawNeedle(ctx, s) {
      if (this.upto >= this.design.cmds.length) return;
      const n = Math.min(this.upto, this.design.cmds.length) - 1;
      for (let i = n; i >= 0; i--) {
        const c = this.design.cmds[i];
        if (c.c === STITCH || c.c === JUMP) {
          const px = (window.devicePixelRatio || 1) / s;
          ctx.beginPath(); ctx.arc(c.x, c.y, 5 * px, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(220,40,60,0.9)'; ctx.fill();
          ctx.lineWidth = 1.5 * px; ctx.strokeStyle = '#fff'; ctx.stroke();
          break;
        }
      }
    }

    _drawPaths(ctx, s) {
      if (!this.design) return;
      const d = this.design;
      const px = (window.devicePixelRatio || 1) / s;
      const segs = this._segments((c) => this.showUnderlay || !c.k);
      const groups = new Map();
      for (const c of segs) {
        const key = c.b * 3 + (c.k === 'u' ? 0 : c.k === 't' ? 1 : 2);
        if (!groups.has(key)) groups.set(key, new Path2D());
        const p = groups.get(key);
        p.moveTo(c.prev.x, c.prev.y); p.lineTo(c.x, c.y);
      }
      ctx.lineCap = 'round';
      for (const key of [...groups.keys()].sort((a, b) => a - b)) {
        const blk = d.blocks[Math.floor(key / 3)];
        if (!blk) continue;
        const kind = key % 3;
        ctx.strokeStyle = E.rgbHex(blk.thread.rgb);
        ctx.globalAlpha = kind === 2 ? 0.95 : 0.45;
        ctx.lineWidth = (kind === 2 ? 1.2 : 1) * px;
        if (kind === 1) ctx.setLineDash([3 * px, 2 * px]); else ctx.setLineDash([]);
        ctx.stroke(groups.get(key));
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // needle penetrations when zoomed in
      if (s / (window.devicePixelRatio || 1) > 7) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        const n = Math.min(d.cmds.length, this.upto);
        const rr = 1.2 * px;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const c = d.cmds[i];
          if (c.c !== STITCH || (!this.showUnderlay && c.k)) continue;
          ctx.moveTo(c.x + rr, c.y); ctx.arc(c.x, c.y, rr, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      if (this.showJumps) {
        ctx.strokeStyle = 'rgba(214,40,120,0.85)';
        ctx.lineWidth = 1 * px;
        ctx.setLineDash([4 * px, 3 * px]);
        ctx.beginPath();
        const n = Math.min(d.cmds.length, this.upto);
        for (let i = 0; i < n; i++) {
          const c = d.cmds[i];
          if (c.c === JUMP && c.prev) { ctx.moveTo(c.prev.x, c.prev.y); ctx.lineTo(c.x, c.y); }
        }
        ctx.stroke();
        ctx.setLineDash([]);
        // trims
        ctx.fillStyle = 'rgba(214,40,120,0.9)';
        for (let i = 0; i < n; i++) {
          const c = d.cmds[i];
          if (c.c === JUMP && c.trim && c.prev) {
            ctx.beginPath(); ctx.arc(c.prev.x, c.prev.y, 2.5 * px, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      this._drawNeedle(ctx, s);
    }

    _drawMap(ctx) {
      const a = this.analysis;
      if (!a) return;
      if (!this._mapCanvas) {
        const c = document.createElement('canvas');
        c.width = a.width; c.height = a.height;
        const g = c.getContext('2d');
        const im = g.createImageData(a.width, a.height);
        const lut = a.colors.map((col, i) => {
          if (i === 0 || !col.include) return null;
          return this.threadForLabel(i).rgb;
        });
        const skip = this.skip;
        for (let i = 0; i < a.labels.length; i++) {
          const rgb = lut[a.labels[i]];
          if (!rgb) continue;
          const off = skip && skip[i];
          im.data[i * 4] = rgb[0]; im.data[i * 4 + 1] = rgb[1]; im.data[i * 4 + 2] = rgb[2];
          im.data[i * 4 + 3] = off ? (((i % a.width) + ((i / a.width) | 0)) % 6 < 2 ? 140 : 40) : 255; // hatched = skipped
        }
        g.putImageData(im, 0, 0);
        this._mapCanvas = c;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this._mapCanvas, 0, 0, a.width * a.res, a.height * a.res);
    }

    _drawOriginal(ctx) {
      const a = this.analysis;
      if (!this.image || !a) return;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.image, 0, 0, a.width * a.res, a.height * a.res);
    }

    invalidateMap() { this._mapCanvas = null; this.draw(); }
  }

  E.Preview = Preview;
})(globalThis.Emb = globalThis.Emb || {});
