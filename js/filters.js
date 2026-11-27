const FILTER_SPECS = {
  none:   { c: 1.05, s: 1.06, e: 1.01, w: 3,  sh: [2, 1, -1],    hi: [4, 2, 0],     lift: 0,  vib: 0.06, grain: 0,   vig: 0.05 },
  paris:  { c: 0.95, s: 1.07, e: 1.05, w: 11, sh: [12, 7, 10],   hi: [14, 7, 6],    lift: 11, vib: 0.10, grain: 1.2, vig: 0.07 },
  golden: { c: 1.08, s: 1.24, e: 1.05, w: 24, sh: [12, 5, -9],   hi: [24, 13, -14], lift: 5,  vib: 0.16, grain: 1.4, vig: 0.11 },
  y2k:    { c: 1.30, s: 1.18, e: 1.05, w: -3, sh: [-8, 4, 12],   hi: [16, 11, 4],   lift: 0,  vib: 0.12, grain: 6.2, vig: 0.28 },
  rio:    { c: 1.14, s: 1.24, e: 1.03, w: 7,  sh: [-14, 12, 22], hi: [24, -2, 12],  lift: 3,  vib: 0.28, grain: 1.4, vig: 0.13 },
  prism:  { c: 1.09, s: 1.20, e: 1.03, w: 4,  sh: [5, 0, 12],    hi: [12, 5, 14],   lift: 4,  vib: 0.18, grain: 1.0, vig: 0.10 },
  noir:   { c: 1.36, s: 0.00, e: 1.03, w: 0,  sh: [0, 0, 0],     hi: [0, 0, 0],     lift: 3,  vib: 0.00, grain: 4.2, vig: 0.26 },
  cyber:  { c: 1.22, s: 1.30, e: 1.02, w: 0,  sh: [-10, 20, 28], hi: [16, -2, 26],  lift: 0,  vib: 0.22, grain: 0.8, vig: 0.14 },
};

const LUT_CACHE = new Map();

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Precompute 256-entry shadow and highlight lookup tables per lens.
 * Eliminates expensive per-pixel Math.pow calls on mobile CPUs.
 */
export function getFilterLUT(mode) {
  if (LUT_CACHE.has(mode)) return LUT_CACHE.get(mode);
  const L = FILTER_SPECS[mode] || FILTER_SPECS.none;
  const shLut = new Float32Array(256);
  const hiLut = new Float32Array(256);

  for (let i = 0; i < 256; i++) {
    shLut[i] = Math.pow(1 - i / 255, 1.45);
    const hiNorm = Math.max(0, Math.min(1, (i - 68) / 187));
    hiLut[i] = Math.pow(hiNorm, 1.35);
  }

  const entry = { L, shLut, hiLut };
  LUT_CACHE.set(mode, entry);
  return entry;
}

/**
 * Pure pixel buffer grading function (safe to execute in Web Workers or Node tests).
 */
export function applyFilterToBuffer(src, out, w, h, mode) {
  const { L, shLut, hiLut } = getFilterLUT(mode);
  const maxShift = Math.max(2, Math.round(w * 0.012));

  for (let y = 0; y < h; y++) {
    const ny = h > 1 ? (y / (h - 1) - 0.5) * 2 : 0;
    for (let x = 0; x < w; x++) {
      const nx = w > 1 ? (x / (w - 1) - 0.5) * 2 : 0;
      const r2 = nx * nx + ny * ny;
      const i = (y * w + x) * 4;

      let r = src[i];
      let g = src[i + 1];
      let b = src[i + 2];

      if (mode === "prism") {
        const shift = Math.round(Math.max(0, r2 - 0.1) * maxShift);
        if (shift > 0) {
          const rx = Math.min(w - 1, x + shift);
          const bx = Math.max(0, x - shift);
          r = src[(y * w + rx) * 4];
          b = src[(y * w + bx) * 4 + 2];
        }
      }

      let flashBoost = 1;
      if (mode === "y2k") {
        flashBoost = 1.08 - 0.18 * Math.min(1.4, r2);
      }

      if (mode === "cyber") {
        const left = Math.max(0, x - 1);
        const right = Math.min(w - 1, x + 1);
        const up = Math.max(0, y - 1);
        const down = Math.min(h - 1, y + 1);
        const gx = Math.abs(src[(y * w + right) * 4] - src[(y * w + left) * 4]);
        const gy = Math.abs(src[(down * w + x) * 4] - src[(up * w + x) * 4]);
        const edge = Math.min(1, (gx + gy) / 150);
        const wave = Math.round(Math.sin(y * 0.055 + x * 0.016) * 2.5);
        const sx = Math.max(0, Math.min(w - 1, x + wave));
        r = src[(y * w + sx) * 4] * 0.88 + edge * 64;
        g = g * 0.8 + edge * 106;
        b = b * 1.14 + edge * 118;
        if ((y & 3) === 0) {
          r *= 0.9;
          g *= 0.92;
          b *= 0.95;
        }
      }

      let lumIdx = Math.round(clampByte(0.299 * r + 0.587 * g + 0.114 * b));
      const sh = shLut[lumIdx];
      const hi = hiLut[lumIdx];

      r = (r - 128) * L.c + 128 + L.lift;
      g = (g - 128) * L.c + 128 + L.lift;
      b = (b - 128) * L.c + 128 + L.lift;

      if (L.vib > 0) {
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        const vBoost = 1 + L.vib * (1 - sat);
        const avg = (r + g + b) / 3;
        r = avg + (r - avg) * vBoost;
        g = avg + (g - avg) * vBoost;
        b = avg + (b - avg) * vBoost;
      }

      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = (lum + (r - lum) * L.s) * L.e * flashBoost + L.w + L.sh[0] * sh + L.hi[0] * hi;
      g = (lum + (g - lum) * L.s) * L.e * flashBoost + L.w * 0.24 + L.sh[1] * sh + L.hi[1] * hi;
      b = (lum + (b - lum) * L.s) * L.e * flashBoost - L.w * 0.46 + L.sh[2] * sh + L.hi[2] * hi;

      if (mode === "noir") {
        const bw = clampByte(0.33 * r + 0.55 * g + 0.12 * b);
        const mono = clampByte((bw - 128) * 1.12 + 130);
        r = g = b = mono;
      }

      const shade = 1 - L.vig * Math.max(0, (r2 - 0.15) / 1.55);
      let noise = 0;
      if (L.grain > 0) {
        const hash = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0;
        noise = ((hash & 1023) / 1023 - 0.5) * L.grain * 2.2;
      }

      out[i] = clampByte(r * shade + noise);
      out[i + 1] = clampByte(g * shade + noise);
      out[i + 2] = clampByte(b * shade + noise);
      out[i + 3] = src[i + 3];
    }
  }
}

function applySoftBloom(canvas, strength, tintColor, blendMode = "screen") {
  const w = canvas.width;
  const h = canvas.height;
  const small = document.createElement("canvas");
  small.width = Math.max(24, Math.round(w / 14));
  small.height = Math.max(24, Math.round(h / 14));
  const sctx = small.getContext("2d");
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(canvas, 0, 0, small.width, small.height);

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.globalCompositeOperation = blendMode;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, w, h);
  if (tintColor) {
    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle = tintColor;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

export function applyPhotoFilter(canvas, mode) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const w = canvas.width;
  const h = canvas.height;

  if (mode === "paris") {
    applySoftBloom(canvas, 0.22, "rgba(255,218,224,0.28)", "soft-light");
    applySoftBloom(canvas, 0.18, null, "screen");
  }

  const image = ctx.getImageData(0, 0, w, h);
  const src = new Uint8ClampedArray(image.data);
  applyFilterToBuffer(src, image.data, w, h, mode);
  ctx.putImageData(image, 0, 0);

  if (mode === "golden") {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const flare = ctx.createRadialGradient(w * 0.86, h * 0.14, 0, w * 0.86, h * 0.14, w * 0.9);
    flare.addColorStop(0, "rgba(255,224,140,0.46)");
    flare.addColorStop(0.35, "rgba(255,172,96,0.18)");
    flare.addColorStop(1, "rgba(255,140,80,0)");
    ctx.fillStyle = flare;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  if (mode === "prism") {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const leak = ctx.createLinearGradient(0, 0, w, h);
    leak.addColorStop(0, "rgba(255,95,180,0.24)");
    leak.addColorStop(0.38, "rgba(110,235,255,0.16)");
    leak.addColorStop(0.72, "rgba(255,225,115,0.15)");
    leak.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = leak;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  if (mode === "cyber") {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.strokeStyle = "rgba(65,235,210,0.45)";
    ctx.lineWidth = Math.max(1, w / 360);
    ctx.beginPath();
    for (let k = 1; k < 7; k++) {
      const yy = (h * k) / 7;
      ctx.moveTo(w * 0.05, yy);
      ctx.lineTo(w * 0.95, yy);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,80,174,0.82)";
    const m = w * 0.055;
    const c = w * 0.07;
    ctx.beginPath();
    ctx.moveTo(m + c, m); ctx.lineTo(m, m); ctx.lineTo(m, m + c);
    ctx.moveTo(w - m - c, m); ctx.lineTo(w - m, m); ctx.lineTo(w - m, m + c);
    ctx.moveTo(m, h - m - c); ctx.lineTo(m, h - m); ctx.lineTo(m + c, h - m);
    ctx.moveTo(w - m - c, h - m); ctx.lineTo(w - m, h - m); ctx.lineTo(w - m, h - m - c);
    ctx.stroke();
    ctx.restore();
  }
}

export function drawStudioPortraitSample(canvas) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#3b3540");
  bg.addColorStop(0.55, "#25232b");
  bg.addColorStop(1, "#141418");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const keyLight = ctx.createRadialGradient(w * 0.34, h * 0.25, 4, w * 0.45, h * 0.35, w * 0.78);
  keyLight.addColorStop(0, "rgba(255, 224, 194, 0.45)");
  keyLight.addColorStop(1, "rgba(255, 224, 194, 0)");
  ctx.fillStyle = keyLight;
  ctx.fillRect(0, 0, w, h);

  // Hair silhouette
  ctx.fillStyle = "#1f1a19";
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.42, w * 0.27, h * 0.31, 0, 0, Math.PI * 2);
  ctx.fill();

  // Shoulders
  ctx.fillStyle = "#5c4a47";
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.94, w * 0.38, h * 0.27, 0, 0, Math.PI * 2);
  ctx.fill();

  // Face tone
  const skin = ctx.createLinearGradient(w * 0.3, h * 0.26, w * 0.7, h * 0.68);
  skin.addColorStop(0, "#eab89d");
  skin.addColorStop(1, "#c78b70");
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.46, w * 0.185, h * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
}
