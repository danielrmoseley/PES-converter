/* UI wiring: load image -> analyse colours -> generate stitches -> preview / download. */
(function (E) {
  'use strict';
  const D = E.digitize;
  const $ = (id) => document.getElementById(id);
  const STORE = 'pes-converter-settings-v1';

  // settings grouped by which pipeline stage they invalidate
  const IMAGE_KEYS = ['colors', 'mergeSimilar', 'foldTinyColors', 'mergeBlends', 'background', 'snapToThreads', 'smoothing', 'minRegion'];
  const STITCH_KEYS = ['spacing', 'stitchLength', 'angle', 'autoAngle', 'pattern', 'underlay', 'pullComp', 'overlap',
    'satin', 'satinMax', 'satinSpacing', 'satinUnderlay', 'shortStitch'];
  const ASM_KEYS = ['trimDistance', 'ties'];
  const FORMAT = {
    colors: (v) => v, smoothing: (v) => v, mergeSimilar: (v) => v + ' ΔE', minRegion: (v) => v.toFixed(1) + ' mm²',
    spacing: (v) => v.toFixed(2) + ' mm', stitchLength: (v) => v.toFixed(1) + ' mm', angle: (v) => v + '°',
    pullComp: (v) => v.toFixed(2) + ' mm', overlap: (v) => v.toFixed(2) + ' mm', satinMax: (v) => v.toFixed(1) + ' mm',
    satinSpacing: (v) => v.toFixed(2) + ' mm', trimDistance: (v) => v.toFixed(1) + ' mm',
  };

  const state = {
    settings: Object.assign({}, D.DEFAULTS, { widthMM: 100, hoop: '130x180' }),
    source: null, name: 'design', crop: null, bgCrop: null,
    analysis: null, design: null, asm: null,
    threadOverride: new Map(), order: null, runId: 0,
  };
  const preview = new E.Preview($('canvas'));

  // ------------------------------------------------------------ settings <-> inputs
  function readInput(key) {
    const el = $(key);
    if (!el) return state.settings[key];
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'range' || el.type === 'number') return parseFloat(el.value);
    return el.value;
  }
  function writeInput(key, v) {
    const el = $(key);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    updateOutput(key);
  }
  function updateOutput(key) {
    const out = $(key + 'Out');
    if (out) out.textContent = (FORMAT[key] || String)(readInput(key));
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state.settings)); } catch (e) { /* private mode */ }
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (s) Object.assign(state.settings, s);
    } catch (e) { /* ignore */ }
    for (const k of [...IMAGE_KEYS, ...STITCH_KEYS, ...ASM_KEYS, 'widthMM', 'hoop']) writeInput(k, state.settings[k]);
  }

  function bindSettings() {
    const wire = (keys, stage) => keys.forEach((k) => {
      const el = $(k);
      if (!el) return;
      el.addEventListener('input', () => updateOutput(k));
      el.addEventListener('change', () => {
        state.settings[k] = readInput(k);
        save();
        if (k === 'background') computeCrop();
        schedule(stage);
      });
    });
    wire(IMAGE_KEYS, 'analyze');
    wire(STITCH_KEYS, 'generate');
    wire(ASM_KEYS, 'assemble');

    $('widthMM').addEventListener('change', () => {
      const w = clamp(readInput('widthMM') || 100, 10, 400);
      state.settings.widthMM = w; writeInput('widthMM', Math.round(w));
      syncHeight(); save(); schedule('analyze');
    });
    $('heightMM').addEventListener('change', () => {
      const h = clamp(readInput('heightMM') || 100, 10, 400);
      const aspect = state.crop ? state.crop.sw / state.crop.sh : 1;
      state.settings.widthMM = Math.round(h * aspect * 10) / 10;
      writeInput('widthMM', Math.round(state.settings.widthMM));
      syncHeight(); save(); schedule('analyze');
    });
    $('hoop').addEventListener('change', () => { state.settings.hoop = $('hoop').value; save(); updateHoop(); });
    $('resetBtn').addEventListener('click', () => {
      state.settings = Object.assign({}, D.DEFAULTS, { widthMM: 100, hoop: '130x180' });
      try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
      load(); computeCrop(); schedule('analyze');
    });
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function syncHeight() {
    const aspect = state.crop ? state.crop.sh / state.crop.sw : 1;
    $('heightMM').value = Math.round(state.settings.widthMM * aspect);
  }

  // ------------------------------------------------------------ image loading
  async function loadFile(file) {
    const isSvg = file && (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || ''));
    if (!file || (!isSvg && !/^image\//.test(file.type))) { setStatus('Please choose a PNG, JPEG or SVG image'); return; }
    let url;
    if (isSvg) {
      try { url = await prepareSvg(file); } catch (e) { setStatus('Could not read that SVG: ' + e.message); return; }
    } else url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch (e) { setStatus('Could not read that image'); return; }
    state.source = img;
    state.name = file.name.replace(/\.[^.]+$/, '') || 'design';
    $('thumb').src = url; $('thumb').hidden = false;
    $('dropText').innerHTML = '<strong>' + escapeHtml(file.name) + '</strong><br><span>' + img.naturalWidth + ' × ' + img.naturalHeight + ' px · click to replace</span>';
    $('empty').hidden = true;
    detectCrop();
    computeCrop();
    preview.cam = null;
    schedule('analyze', 0);
  }

  /**
   * Give an SVG an explicit, large intrinsic size so the browser rasterises the vector crisply at
   * whatever working resolution we need (many SVGs only have a viewBox, or a tiny width/height).
   */
  async function prepareSvg(file) {
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('not a valid SVG file');
    const num = (v) => { const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v || ''); return m ? parseFloat(m[1]) : NaN; };
    let vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    let w = num(svg.getAttribute('width')), h = num(svg.getAttribute('height'));
    if (vb.length !== 4 || vb.some(isNaN) || vb[2] <= 0 || vb[3] <= 0) {
      if (!(w > 0 && h > 0)) { w = 1000; h = 1000; }
      vb = [0, 0, w, h];
      svg.setAttribute('viewBox', vb.join(' '));
    }
    const aspect = vb[3] / vb[2];
    const long = 2400;
    const W = aspect <= 1 ? long : Math.round(long / aspect), H = aspect <= 1 ? Math.round(long * aspect) : long;
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const blob = new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' });
    return URL.createObjectURL(blob);
  }

  /** find the content bounding box (ignoring a uniform / transparent background) */
  function detectCrop() {
    const img = state.source;
    const w = img.naturalWidth, h = img.naturalHeight;
    const k = Math.min(1, 400 / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, cw, ch);
    const L = E.img.toLab(g.getImageData(0, 0, cw, ch));
    const bg = E.img.detectBackground(L);
    const b = bg ? E.img.contentBounds(L, bg) : null;
    if (b) {
      const pad = 2;
      const x0 = clamp((b.x0 - pad) / k, 0, w), y0 = clamp((b.y0 - pad) / k, 0, h);
      const x1 = clamp((b.x1 + 1 + pad) / k, 0, w), y1 = clamp((b.y1 + 1 + pad) / k, 0, h);
      state.bgCrop = { sx: x0, sy: y0, sw: Math.max(1, x1 - x0), sh: Math.max(1, y1 - y0) };
    } else state.bgCrop = null;
  }

  function computeCrop() {
    if (!state.source) return;
    const full = { sx: 0, sy: 0, sw: state.source.naturalWidth, sh: state.source.naturalHeight };
    state.crop = state.settings.background !== 'keep' && state.bgCrop ? state.bgCrop : full;
    syncHeight();
  }

  function workingImage() {
    const { sx, sy, sw, sh } = state.crop;
    const wMM = state.settings.widthMM, hMM = wMM * sh / sw;
    const maxMM = Math.max(wMM, hMM);
    const longPx = clamp(Math.round(maxMM / 0.15), 300, 900);
    const W = Math.max(8, Math.round(longPx * wMM / maxMM)), H = Math.max(8, Math.round(longPx * hMM / maxMM));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(state.source, sx, sy, sw, sh, 0, 0, W, H);
    return { canvas: c, data: g.getImageData(0, 0, W, H), res: wMM / W };
  }

  // ------------------------------------------------------------ pipeline
  let timer = null, pendingStage = null;
  const RANK = { analyze: 0, generate: 1, assemble: 2 };
  function schedule(stage, delay = 120) {
    if (!state.source) return;
    if (pendingStage === null || RANK[stage] < RANK[pendingStage]) pendingStage = stage;
    clearTimeout(timer);
    timer = setTimeout(() => { const s = pendingStage; pendingStage = null; run(s); }, delay);
  }

  const nextFrame = () => new Promise((r) => setTimeout(r, 16));

  async function run(stage) {
    const id = ++state.runId;
    const alive = () => id === state.runId;
    busy(true);
    try {
      if (stage === 'analyze' || !state.analysis) {
        busy(true, 'Reducing colours…');
        await nextFrame();
        const wi = workingImage();
        const an = D.analyze(wi.data, wi.res, state.settings);
        if (!alive()) return;
        state.analysis = an;
        state.threadOverride.clear();
        state.skip = new Uint8Array(an.labels.length);
        preview.skip = state.skip;
        state.order = null;
        preview.setImage(wi.canvas);
        preview.setAnalysis(an, threadForLabel);
        stage = 'generate';
      }
      if (stage === 'generate' || !state.design) {
        busy(true, 'Digitizing stitches…');
        await nextFrame();
        const s = Object.assign({}, state.settings, { colorOrder: state.order });
        const design = await D.generate(withSkips(state.analysis), s, (f) => { if (alive()) busy(true, 'Digitizing stitches… ' + Math.round(f * 100) + '%'); });
        if (!alive()) return;
        state.design = design;
        if (!state.order) state.order = design.layers.map((l) => l.colorIndex);
      }
      assemble();
      renderColorList();
      setStatus('Ready');
    } catch (err) {
      console.error(err);
      setStatus('Something went wrong: ' + err.message);
    } finally {
      if (alive()) busy(false);
    }
  }

  // ------------------------------------------------------------ per-shape skip / include
  /** analysis as it should be sewn: user-skipped shapes become fabric, and colours that use the
   *  same thread are merged so each thread is sewn in one block (one stop, not several) */
  function withSkips(an) {
    const canon = new Map(), remap = new Uint8Array(an.colors.length);
    let merge = false;
    for (let l = 1; l < an.colors.length; l++) {
      remap[l] = l;
      if (!an.colors[l].include) continue;
      const t = threadForLabel(l).index;
      if (canon.has(t)) { remap[l] = canon.get(t); merge = true; } else canon.set(t, l);
    }
    const skips = state.skip && state.skip.some((v) => v);
    if (!skips && !merge) return an;
    const labels = new Uint8Array(an.labels);
    for (let i = 0; i < labels.length; i++) labels[i] = state.skip && state.skip[i] ? 0 : remap[labels[i]];
    return Object.assign({}, an, { labels });
  }

  /** flood-fill the connected shape of one label from pixel i */
  function shapeAt(an, i, conn) {
    const { labels, width: w, height: h } = an;
    const l = labels[i], seen = new Uint8Array(labels.length), out = [i], st = [i];
    seen[i] = 1;
    let touchesBorder = false;
    while (st.length) {
      const j = st.pop(), x = j % w, y = (j / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (conn === 4 && dx && dy)) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (!seen[k] && labels[k] === l) { seen[k] = 1; out.push(k); st.push(k); }
      }
    }
    return { pixels: out, touchesBorder };
  }

  function pick(X, Y) {
    const an = state.analysis;
    if (!an) return;
    const x = Math.floor(X / an.res), y = Math.floor(Y / an.res);
    if (x < 0 || y < 0 || x >= an.width || y >= an.height) return;
    const i = y * an.width + x;
    const l = an.labels[i];
    if (l === 0) {
      const sh = shapeAt(an, i, 4);
      if (sh.touchesBorder) { setStatus('That’s the surrounding background — it isn’t stitched'); return; }
      // stitch this enclosed gap using the "enclosed areas" colour (created on demand)
      let label = an.colors.findIndex((c, k) => k > 0 && c.enclosedBackground);
      if (label < 0) {
        const lab = (an.background && an.background.lab) || E.rgbToLab(255, 255, 255);
        const t = E.nearestThread(lab);
        an.colors.push({ lab: t.lab, rgb: t.rgb.slice(), thread: t, srcLab: lab, count: 0, include: true, enclosedBackground: true });
        label = an.colors.length - 1;
      }
      for (const k of sh.pixels) { an.labels[k] = label; state.skip[k] = 0; }
      an.colors[label].count += sh.pixels.length;
      an.colors[0].count -= sh.pixels.length;
      setStatus('Enclosed area will be stitched — click it again to skip it');
    } else {
      const sh = shapeAt(an, i, 8);
      const on = state.skip[i] ? 0 : 1;
      for (const k of sh.pixels) state.skip[k] = on;
      setStatus(on ? 'Shape skipped — click it again to stitch it' : 'Shape will be stitched');
    }
    preview.invalidateMap();
    schedule('generate', 0);
  }
  preview.onPick = pick;

  function threadForLabel(label) {
    const o = state.threadOverride.get(label);
    if (o) return E.threadByIndex(o);
    return state.analysis.colors[label].thread;
  }

  function assemble() {
    const asm = D.assemble(state.design, state.settings, (layer) => threadForLabel(layer.colorIndex));
    state.asm = asm;
    const firstTime = !preview.design;
    preview.setDesign(asm.cmds, asm.blocks);
    preview.upto = Infinity;
    $('progress').max = asm.cmds.length; $('progress').value = asm.cmds.length; $('progress').disabled = false;
    $('playBtn').disabled = false;
    updateProgressText();
    if (firstTime || !preview.cam) preview.fit();
    $('downloadBtn').disabled = asm.stats.stitches === 0;
    updateStats();
    updateHoop();
  }

  function designSize() {
    if (!preview.design) return [0, 0];
    const [x0, y0, x1, y1] = preview.design.bounds;
    return [x1 - x0, y1 - y0];
  }

  function updateStats() {
    const st = state.asm.stats;
    const [w, h] = designSize();
    $('stSize').textContent = w.toFixed(1) + ' × ' + h.toFixed(1) + ' mm';
    $('stStitches').textContent = st.stitches.toLocaleString();
    $('stColors').textContent = st.colors + (st.colors === 1 ? ' (no stops)' : ' · ' + (st.colors - 1) + ' stop' + (st.colors === 2 ? '' : 's'));
    $('stTrims').textContent = st.trims + ' · ' + st.runs + ' runs';
    const ds = state.design.stats;
    $('stShapes').textContent = ds.fill + ' fill · ' + ds.satin + ' satin';
    const minutes = st.stitches / 650 + st.trims * 6 / 60 + Math.max(0, st.colors - 1) * 0.5;
    $('stTime').textContent = '≈ ' + Math.max(1, Math.round(minutes)) + ' min';
  }

  function updateHoop() {
    const [hw, hh] = state.settings.hoop.split('x').map(Number);
    preview.hoop = [hw, hh];
    const [w, h] = designSize();
    const fits = (w <= hw && h <= hh) || (w <= hh && h <= hw);
    const warn = $('hoopWarn');
    if (preview.design && !fits) {
      warn.hidden = false;
      warn.textContent = `Design (${w.toFixed(0)} × ${h.toFixed(0)} mm) is larger than the ${hw} × ${hh} mm hoop.`;
    } else warn.hidden = true;
    if (w > hw && w <= hh && h <= hw) preview.hoop = [hh, hw];
    preview.draw();
  }

  // ------------------------------------------------------------ colour list
  const THREAD_OPTIONS = E.THREADS.map((t) => `<option value="${t.index}">${t.index}. ${t.name}</option>`).join('');

  function renderColorList() {
    const an = state.analysis, list = $('colorList');
    list.innerHTML = '';
    if (!an) return;
    const total = an.colors.reduce((a, c, i) => a + (i ? c.count : 0), 0) || 1;
    const kinds = new Map();
    for (const l of state.design.layers) {
      const f = l.regions.filter((r) => r.kind === 'fill').length, s = l.regions.length - f;
      kinds.set(l.colorIndex, [f ? f + ' fill' : '', s ? s + ' satin' : ''].filter(Boolean).join(' · '));
    }
    const order = (state.order || []).slice();
    for (let i = 1; i < an.colors.length; i++) if (!order.includes(i)) order.push(i);
    order.forEach((label, pos) => {
      const c = an.colors[label];
      if (!c) return;
      const t = threadForLabel(label);
      const item = document.createElement('div');
      item.className = 'color-item' + (c.include ? '' : ' off');
      item.innerHTML = `
        <input type="checkbox" ${c.include ? 'checked' : ''} title="Stitch this colour">
        <div class="sw" style="background:${E.rgbHex(t.rgb)}"></div>
        <div><select title="Thread">${THREAD_OPTIONS}</select>
          <div class="meta">${pos + 1}. ${(100 * c.count / total).toFixed(1)}%${c.enclosedBackground ? ' · enclosed areas' : ''} ${c.include ? '· ' + (kinds.get(label) || '') : '· skipped'}</div></div>
        <div class="order"><button title="Sew earlier">▲</button><button title="Sew later">▼</button></div>`;
      const sel = item.querySelector('select');
      sel.value = String(t.index);
      sel.addEventListener('change', () => {
        state.threadOverride.set(label, parseInt(sel.value, 10));
        preview.invalidateMap();
        schedule('generate', 0); // same thread as another entry -> merged into one block (one stop)
      });
      item.querySelector('input').addEventListener('change', (e) => {
        c.include = e.target.checked;
        preview.invalidateMap();
        schedule('generate', 0);
      });
      const [up, down] = item.querySelectorAll('.order button');
      up.disabled = pos === 0; down.disabled = pos === order.length - 1;
      const move = (d) => {
        const o = order.slice();
        const j = pos + d;
        [o[pos], o[j]] = [o[j], o[pos]];
        state.order = o;
        schedule('generate', 0);
      };
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      list.appendChild(item);
    });
  }

  // ------------------------------------------------------------ preview controls
  function bindPreview() {
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      preview.mode = b.dataset.mode;
      $('underlayToggle').hidden = $('jumpToggle').hidden = preview.mode !== 'paths';
      preview.draw();
    }));
    $('showUnderlay').addEventListener('change', (e) => { preview.showUnderlay = e.target.checked; preview.draw(); });
    $('showJumps').addEventListener('change', (e) => { preview.showJumps = e.target.checked; preview.draw(); });
    $('fabric').addEventListener('input', (e) => {
      preview.fabric = e.target.value;
      document.querySelector('.canvas-wrap').style.background = e.target.value;
      preview.draw();
    });
    $('zoomIn').addEventListener('click', () => preview.zoom(1.4));
    $('zoomOut').addEventListener('click', () => preview.zoom(1 / 1.4));
    $('zoomFit').addEventListener('click', () => preview.fit());

    let playing = false, raf = 0;
    const stop = () => { playing = false; cancelAnimationFrame(raf); $('playBtn').textContent = '▶'; };
    $('progress').addEventListener('input', (e) => {
      stop();
      const v = parseInt(e.target.value, 10);
      preview.upto = v >= state.asm.cmds.length ? Infinity : v;
      updateProgressText(); preview.draw();
    });
    $('playBtn').addEventListener('click', () => {
      if (playing) { stop(); return; }
      const n = state.asm.cmds.length;
      let pos = preview.upto >= n ? 0 : preview.upto;
      playing = true; $('playBtn').textContent = '❚❚';
      const stepPer = Math.max(5, Math.round(n / 600));
      const tickFn = () => {
        if (!playing) return;
        pos = Math.min(n, pos + stepPer);
        preview.upto = pos >= n ? Infinity : pos;
        $('progress').value = pos;
        updateProgressText(); preview.draw();
        if (pos >= n) { stop(); return; }
        raf = requestAnimationFrame(tickFn);
      };
      raf = requestAnimationFrame(tickFn);
    });
  }

  function updateProgressText() {
    if (!state.asm) return;
    const n = state.asm.cmds.length;
    const upto = Math.min(n, preview.upto);
    let st = 0, total = state.asm.stats.stitches;
    for (let i = 0; i < upto; i++) if (state.asm.cmds[i].c === E.pes.STITCH) st++;
    $('progressText').textContent = st.toLocaleString() + ' / ' + total.toLocaleString() + ' stitches';
  }

  // ------------------------------------------------------------ download / drop / misc
  function download() {
    if (!state.asm) return;
    const bytes = E.pes.writePES(state.asm.cmds, state.asm.colorIdx, state.name);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.name || 'design').replace(/[^\w\- ]+/g, '_') + '.pes';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setStatus('Saved ' + a.download + ' (' + (bytes.length / 1024).toFixed(1) + ' KB)');
  }

  function bindFiles() {
    $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
    const drop = $('drop');
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragover'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragover'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragover');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    drop.addEventListener('dragover', () => drop.classList.add('over'));
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    window.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData || {}).items || []].find((i) => i.type.startsWith('image/'));
      if (item) loadFile(item.getAsFile());
    });
    $('downloadBtn').addEventListener('click', download);
  }

  function setStatus(t) { $('status').textContent = t; }
  function busy(on, text) {
    $('busy').hidden = !on;
    if (text) $('busyText').textContent = text;
  }
  function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  load();
  bindSettings();
  bindPreview();
  bindFiles();
  updateHoop();
})(globalThis.Emb = globalThis.Emb || {});
