/* Brother PEC thread palette + colour-space helpers.
 * PES v1 files store colours as indices into this fixed 64-entry chart,
 * so the converter snaps colours to it to make the preview match the machine. */
(function (E) {
  'use strict';

  const RAW = [
    [14, 31, 124, 'Prussian Blue'], [10, 85, 163, 'Blue'], [0, 135, 119, 'Teal Green'],
    [75, 107, 175, 'Cornflower Blue'], [237, 23, 31, 'Red'], [209, 92, 0, 'Reddish Brown'],
    [145, 54, 151, 'Magenta'], [228, 154, 203, 'Light Lilac'], [145, 95, 172, 'Lilac'],
    [158, 214, 125, 'Mint Green'], [232, 169, 0, 'Deep Gold'], [254, 186, 53, 'Orange'],
    [255, 255, 0, 'Yellow'], [112, 188, 31, 'Lime Green'], [186, 152, 0, 'Brass'],
    [168, 168, 168, 'Silver'], [125, 111, 0, 'Russet Brown'], [255, 255, 179, 'Cream Brown'],
    [79, 85, 86, 'Pewter'], [0, 0, 0, 'Black'], [11, 61, 145, 'Ultramarine'],
    [119, 1, 118, 'Royal Purple'], [41, 49, 51, 'Dark Gray'], [42, 19, 1, 'Dark Brown'],
    [246, 74, 138, 'Deep Rose'], [178, 118, 36, 'Light Brown'], [252, 187, 197, 'Salmon Pink'],
    [254, 55, 15, 'Vermilion'], [240, 240, 240, 'White'], [106, 28, 138, 'Violet'],
    [168, 221, 196, 'Seacrest'], [37, 132, 187, 'Sky Blue'], [254, 179, 67, 'Pumpkin'],
    [255, 243, 107, 'Cream Yellow'], [208, 166, 96, 'Khaki'], [209, 84, 0, 'Clay Brown'],
    [102, 186, 73, 'Leaf Green'], [19, 74, 70, 'Peacock Blue'], [135, 135, 135, 'Gray'],
    [216, 204, 198, 'Warm Gray'], [67, 86, 7, 'Dark Olive'], [253, 217, 222, 'Flesh Pink'],
    [249, 147, 188, 'Pink'], [0, 56, 34, 'Deep Green'], [178, 175, 212, 'Lavender'],
    [104, 106, 176, 'Wisteria Violet'], [239, 227, 185, 'Beige'], [247, 56, 102, 'Carmine'],
    [181, 75, 100, 'Amber Red'], [19, 43, 26, 'Olive Green'], [199, 1, 86, 'Dark Fuchsia'],
    [254, 158, 50, 'Tangerine'], [168, 222, 235, 'Light Blue'], [0, 103, 62, 'Emerald Green'],
    [78, 41, 144, 'Purple'], [47, 126, 32, 'Moss Green'], [255, 204, 204, 'Flesh Pink'],
    [255, 217, 17, 'Harvest Gold'], [9, 91, 166, 'Electric Blue'], [240, 249, 112, 'Lemon Yellow'],
    [227, 243, 91, 'Fresh Green'], [255, 153, 0, 'Orange'], [255, 240, 141, 'Cream Yellow'],
  ];

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  // Lookup table: 8-bit sRGB -> linear
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i);

  function labF(t) { return t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116); }

  function rgbToLab(r, g, b) {
    const R = LIN[r | 0], G = LIN[g | 0], B = LIN[b | 0];
    const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
    const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const fx = labF(x), fy = labF(y), fz = labF(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = (t) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
    const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
    let R = x * 3.2406 + y * -1.5372 + z * -0.4986;
    let G = x * -0.9689 + y * 1.8758 + z * 0.0415;
    let B = x * 0.0557 + y * -0.2040 + z * 1.0570;
    const g = (c) => {
      c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
      return Math.max(0, Math.min(255, Math.round(c * 255)));
    };
    return [g(R), g(G), g(B)];
  }

  function labDist2(a, b) {
    const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
    return dl * dl + da * da + db * db;
  }

  /** CIEDE2000 colour difference (perceptual; what the textile industry uses for thread matching) */
  function deltaE2000(l1, l2) {
    const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
    const rad = Math.PI / 180, deg = 180 / Math.PI;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const h = (b, a) => { if (!a && !b) return 0; const v = Math.atan2(b, a) * deg; return v < 0 ? v + 360 : v; };
    const h1p = h(b1, a1p), h2p = h(b2, a2p);
    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = h1p + h2p;
    if (C1p * C2p) { hbp = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2; }
    const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
    const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
    const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
    const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
    const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
    const Rt = -Math.sin(2 * dTheta * rad) * Rc;
    return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
  }

  // index (1-based) == PEC colour index written to the file
  const THREADS = RAW.map((t, i) => ({
    index: i + 1,
    name: t[3],
    rgb: [t[0], t[1], t[2]],
    lab: rgbToLab(t[0], t[1], t[2]),
  }));

  function nearestThread(lab, exclude) {
    let best = null, bd = Infinity;
    for (const t of THREADS) {
      if (exclude && exclude.has(t.index)) continue;
      const d = deltaE2000(lab, t.lab);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  function threadByIndex(i) { return THREADS[i - 1] || THREADS[19]; }

  function rgbHex(rgb) {
    return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  E.THREADS = THREADS;
  E.rgbToLab = rgbToLab;
  E.labToRgb = labToRgb;
  E.labDist2 = labDist2;
  E.deltaE2000 = deltaE2000;
  E.nearestThread = nearestThread;
  E.threadByIndex = threadByIndex;
  E.rgbHex = rgbHex;
})(globalThis.Emb = globalThis.Emb || {});
