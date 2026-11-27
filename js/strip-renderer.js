import { THEMES } from "./config.js";
import { applyPhotoFilter } from "./filters.js";

/**
 * Pure layout geometry calculator (tested directly in Node).
 */
export function computeStripLayout(frameDims, layoutType = "strip-4") {
  const usable = layoutType === "strip-3" ? frameDims.slice(0, 3) : frameDims.slice(0, 4);

  if (layoutType === "grid-2x2") {
    const W = 960;
    const pad = 28;
    const gap = 18;
    const headerH = 190;
    const footerH = 140;
    const cellW = Math.floor((W - pad * 2 - gap) / 2);
    const firstRatio = usable[0] ? usable[0].height / usable[0].width : 4 / 3;
    const cellH = Math.round(cellW * firstRatio);
    const rows = Math.ceil(usable.length / 2);
    const slots = usable.map((_, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      return {
        index: i,
        x: pad + col * (cellW + gap),
        y: headerH + row * (cellH + gap),
        width: cellW,
        height: cellH,
      };
    });
    const H = headerH + rows * cellH + Math.max(0, rows - 1) * gap + footerH;
    return { width: W, height: H, headerY: headerH, footerY: H - footerH, slots };
  }

  // Classic vertical strip (1x4 or 1x3)
  const W = 720;
  const x = 22;
  const frameW = 676;
  const yStart = 248;
  const gap = 22;
  const footerH = 178;

  let curY = yStart;
  const slots = usable.map((dim, i) => {
    const fH = Math.round(frameW * (dim.height / dim.width));
    const slot = { index: i, x, y: curY, width: frameW, height: fH };
    curY += fH + gap;
    return slot;
  });

  const H = Math.max(yStart + footerH, curY - gap + footerH);
  return { width: W, height: H, headerY: yStart, footerY: curY - gap + 40, slots };
}

/**
 * Returns ordered canvas transform ops for a captured frame.
 * Rotation is applied before horizontal mirroring so mirrored selfies rotate
 * in the requested visual direction rather than reversing.
 */
export function getFrameCanvasOps(mirror, extraDeg = 0) {
  const deg = ((extraDeg % 360) + 360) % 360;
  const ops = [];
  if (deg !== 0) ops.push({ type: "rotate", rad: (deg * Math.PI) / 180 });
  if (mirror) ops.push({ type: "scale", sx: -1, sy: 1 });
  return ops;
}

export function renderCapturedFrameToCanvas(rawCapture, extraDeg, look) {
  const src = rawCapture.canvas;
  const deg = ((extraDeg % 360) + 360) % 360;
  const quarterTurn = deg === 90 || deg === 270;
  const orientedW = quarterTurn ? src.height : src.width;
  const orientedH = quarterTurn ? src.width : src.height;

  const maxDim = 1040;
  const fitScale = maxDim / Math.max(orientedW, orientedH);
  const outW = Math.max(1, Math.round(orientedW * fitScale));
  const outH = Math.max(1, Math.round(orientedH * fitScale));
  const drawW = src.width * fitScale;
  const drawH = src.height * fitScale;

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d", { willReadFrequently: true });

  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  for (const op of getFrameCanvasOps(Boolean(rawCapture.mirror), deg)) {
    if (op.type === "rotate") ctx.rotate(op.rad);
    else if (op.type === "scale") ctx.scale(op.sx, op.sy);
  }
  ctx.drawImage(src, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  applyPhotoFilter(out, look);
  return out;
}

export function canvasToJpegBlob(canvas, quality = 0.92) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function renderStripArtifact({
  frameDataUrls,
  themeId = "pink",
  layoutType = "strip-4",
  eventConfig = {},
  caption = "",
}) {
  const t = THEMES[themeId] || THEMES.pink;
  const imgs = await Promise.all(frameDataUrls.map(loadImage));
  const dims = imgs.map((img) => ({ width: img.width, height: img.height }));
  const layout = computeStripLayout(dims, layoutType);

  const maxCanvasH = 4000;
  const outScale = layout.height > maxCanvasH ? maxCanvasH / layout.height : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(layout.width * outScale);
  canvas.height = Math.round(layout.height * outScale);

  const ctx = canvas.getContext("2d");
  if (outScale !== 1) ctx.scale(outScale, outScale);

  const W = layout.width;
  const H = layout.height;

  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, W - 36, H - 36);

  // Header branding
  ctx.textAlign = "center";
  ctx.fillStyle = t.ink;
  const cx = W / 2;

  if (layoutType === "grid-2x2") {
    ctx.font = "600 15px 'Space Grotesk', Arial, sans-serif";
    ctx.fillText(eventConfig.subtitle || "BGKV · STUDIO", cx, 64);
    ctx.font = "700 44px 'Space Grotesk', Arial, sans-serif";
    ctx.fillText(eventConfig.title || "MINISNAP PHOTOBOOTH", cx, 118);
    ctx.fillStyle = t.accent;
    ctx.fillRect(cx - 120, 144, 240, 3);
  } else {
    ctx.font = "600 16px 'Space Grotesk', Arial, sans-serif";
    ctx.fillText("A LITTLE MEMORY FROM", cx, 72);
    ctx.font = "700 54px 'Space Grotesk', Arial, sans-serif";
    ctx.fillText((eventConfig.subtitle || "BGKV").split("·")[0].trim(), cx, 134);
    ctx.font = "700 22px 'Space Grotesk', Arial, sans-serif";
    ctx.fillText(eventConfig.title || "MINISNAP PHOTOBOOTH", cx, 174);
    ctx.font = "500 13px 'JetBrains Mono', Arial, sans-serif";
    ctx.fillStyle = t.accent;
    ctx.fillText("BHAVAN'S GANGABUX KANORIA VIDYAMANDIR", cx, 203);
    ctx.fillRect(cx - 115, 222, 230, 3);
  }

  for (const slot of layout.slots) {
    const img = imgs[slot.index];
    if (!img) continue;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(slot.x, slot.y, slot.width, slot.height, 8);
    ctx.clip();
    // Cover-crop cleanly inside cell
    const scale = Math.max(slot.width / img.width, slot.height / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const dx = slot.x + (slot.width - drawW) / 2;
    const dy = slot.y + (slot.height - drawH) / 2;
    ctx.drawImage(img, dx, dy, drawW, drawH);
    ctx.restore();

    ctx.fillStyle = "rgba(25, 20, 18, 0.52)";
    ctx.beginPath();
    ctx.roundRect(slot.x + slot.width - 48, slot.y + slot.height - 40, 36, 28, 6);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 13px 'JetBrains Mono', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`0${slot.index + 1}`, slot.x + slot.width - 30, slot.y + slot.height - 21);
  }

  const bottomY = layout.footerY;
  ctx.textAlign = "center";
  ctx.fillStyle = t.ink;

  const dateText = new Date().toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  if (caption) {
    ctx.font = "600 20px 'Space Grotesk', Arial, sans-serif";
    ctx.fillText(caption, cx, bottomY);
    ctx.font = "500 14px 'JetBrains Mono', Arial, sans-serif";
    ctx.fillStyle = t.accent;
    ctx.fillText(`${dateText} · ${eventConfig.footerText || "A SCHOOL MEMORY"}`, cx, bottomY + 34);
  } else {
    ctx.font = "600 19px 'Space Grotesk', Arial, sans-serif";
    ctx.fillText(dateText, cx, bottomY);
    ctx.font = "500 14px 'JetBrains Mono', Arial, sans-serif";
    ctx.fillStyle = t.accent;
    ctx.fillText(eventConfig.footerText || "A SCHOOL MEMORY · KOLKATA", cx, bottomY + 34);
  }

  ctx.font = "700 15px 'Space Grotesk', Arial, sans-serif";
  ctx.fillStyle = t.ink;
  ctx.fillText("BGKV × MINISNAP", cx, bottomY + 72);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.93);
  const blob = await canvasToJpegBlob(canvas, 0.93);
  return { dataUrl, blob };
}
