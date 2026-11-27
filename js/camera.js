import { POSE_PROMPTS } from "./config.js";
import { state } from "./state.js";
import { canvasToJpegBlob, renderCapturedFrameToCanvas } from "./strip-renderer.js";

let audioCtx = null;

function getAudioContext() {
  if (!state.soundEnabled) return null;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  if (!audioCtx) audioCtx = new AudioCtor();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

export function playTone(freq = 660, duration = 0.08, gain = 0.05) {
  const ctx = getAudioContext();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const vol = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  vol.gain.setValueAtTime(gain, ctx.currentTime);
  vol.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
  osc.connect(vol);
  vol.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

export function playShutterSound() {
  const ctx = getAudioContext();
  if (!ctx) return;
  playTone(1120, 0.045, 0.07);
  setTimeout(() => playTone(440, 0.07, 0.05), 35);
}

export async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
      });
    }
  } catch {
    // WakeLock optional on unsupported browsers
  }
}

export async function releaseWakeLock() {
  try {
    if (state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch {
    state.wakeLock = null;
  }
}

export function stopCamera(videoEl, placeholderEl) {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  if (videoEl) {
    videoEl.srcObject = null;
    videoEl.classList.remove("is-selfie");
  }
  if (placeholderEl) {
    placeholderEl.style.display = "flex";
    const msgEl = placeholderEl.querySelector?.("#placeholderMsg");
    if (msgEl) msgEl.textContent = "Requesting camera access…";
  }
  releaseWakeLock();
}

export async function startCamera({ videoEl, placeholderEl, hudCameraEl, statusEl, onReady }) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Secure HTTPS connection required for camera access.");
  }

  stopCamera(videoEl, placeholderEl);

  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: state.facing },
      width: { ideal: 1280 },
      height: { ideal: 1600 },
    },
  });

  videoEl.srcObject = state.stream;
  await videoEl.play();

  const isSelfie = state.facing === "user";
  videoEl.classList.toggle("is-selfie", isSelfie);
  if (hudCameraEl) {
    hudCameraEl.textContent = isSelfie ? "SELFIE · MIRROR" : "REAR CAMERA";
  }

  const track = state.stream.getVideoTracks()[0];
  try {
    const caps = track?.getCapabilities?.();
    if (caps?.zoom && caps.zoom.min <= 0.5 && caps.zoom.max >= 0.5) {
      await track.applyConstraints({ advanced: [{ zoom: 0.5 }] });
    }
  } catch {
    // Default optical zoom retained
  }

  if (placeholderEl) placeholderEl.style.display = "none";
  if (statusEl) statusEl.textContent = "● READY";
  await acquireWakeLock();
  onReady?.();
}

/**
 * Captures a single 3:4 center-cropped frame from the live <video> without forced sideways rotation.
 */
export function captureSlotFrame(videoEl, slotIndex, flashEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) throw new Error("Camera feed is not ready.");

  const targetRatio = 3 / 4;
  const videoRatio = vw / vh;
  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;

  if (videoRatio > targetRatio) {
    sw = Math.round(vh * targetRatio);
    sx = Math.round((vw - sw) / 2);
  } else if (videoRatio < targetRatio) {
    sh = Math.round(vw / targetRatio);
    sy = Math.round((vh - sh) / 2);
  }

  const rawCanvas = document.createElement("canvas");
  rawCanvas.width = sw;
  rawCanvas.height = sh;
  rawCanvas.getContext("2d").drawImage(videoEl, sx, sy, sw, sh, 0, 0, sw, sh);

  state.rawCaptures[slotIndex] = {
    canvas: rawCanvas,
    mirror: state.facing === "user",
  };

  if (flashEl) {
    flashEl.classList.remove("fire");
    void flashEl.offsetWidth;
    flashEl.classList.add("fire");
  }
  playShutterSound();
}

export async function rebuildFramesFromRaw() {
  const canvases = state.rawCaptures.map((raw) =>
    renderCapturedFrameToCanvas(raw, state.extraRotation, state.filter),
  );
  state.frameDataUrls = canvases.map((c) => c.toDataURL("image/jpeg", 0.93));
  state.frameBlobs = await Promise.all(canvases.map((c) => canvasToJpegBlob(c, 0.91)));
}

export function delay(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Capture cancelled.", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Capture cancelled.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runCountdown(seconds, slotIndex, countdownEl, signal) {
  if (signal?.aborted) {
    if (countdownEl) countdownEl.style.display = "none";
    throw new DOMException("Capture cancelled.", "AbortError");
  }
  const promptText = POSE_PROMPTS[slotIndex] || "Hold your pose";
  try {
    for (let n = seconds; n >= 1; n--) {
      if (signal?.aborted) {
        throw new DOMException("Capture cancelled.", "AbortError");
      }
      countdownEl.style.display = "flex";
      countdownEl.replaceChildren();

      const num = document.createElement("span");
      num.textContent = String(n);
      const cue = document.createElement("span");
      cue.className = "pose-cue";
      cue.textContent = promptText;
      countdownEl.append(num, cue);

      countdownEl.style.animation = "none";
      void countdownEl.offsetWidth;
      countdownEl.style.animation = "";

      playTone(n === 1 ? 880 : 540, 0.09, 0.05);
      await delay(1000, signal);
    }
  } finally {
    if (countdownEl) countdownEl.style.display = "none";
  }
}
