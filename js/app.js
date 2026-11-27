import { FILTERS, LAYOUTS, THEMES } from "./config.js";
import { setBoothToken, setEventPass, state } from "./state.js";
import { applyPhotoFilter, drawStudioPortraitSample } from "./filters.js";
import {
  captureSlotFrame,
  delay,
  rebuildFramesFromRaw,
  runCountdown,
  startCamera,
  stopCamera,
} from "./camera.js";
import { renderStripArtifact } from "./strip-renderer.js";
import {
  countPendingQueue,
  enqueueSession,
  listQueuedSessions,
  removeQueuedSession,
} from "./offline-queue.js";
import { edgeRequest, uploadSessionBundle } from "./supabase-api.js";
import { initHomepageMotion } from "./motion.js";
import { initAdminUI, loadAdminDashboard, renderQrCode } from "./admin.js";
import { closeModal, openModal } from "./modal.js";

let flushingQueue = false;
let pinBuffer = "";
let pinResolve = null;
let captureAbortController = null;

function abortActiveCapture() {
  if (captureAbortController) {
    captureAbortController.abort();
    captureAbortController = null;
  }
  const countdownEl = document.getElementById("countdown");
  if (countdownEl) countdownEl.style.display = "none";
}

function showScreen(id) {
  state.screen = id;
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const targetScreen = document.getElementById(id);
  targetScreen?.classList.add("active");

  const stepper = document.getElementById("stepper");
  const order = ["setup", "cameraScreen", "resultScreen"];
  const idx = order.indexOf(id);
  if (idx === -1) {
    stepper.classList.add("hidden");
    stepper.querySelectorAll("[data-step]").forEach((pill) => {
      pill.removeAttribute("aria-current");
    });
  } else {
    stepper.classList.remove("hidden");
    stepper.querySelectorAll("[data-step]").forEach((pill, i) => {
      const isActive = i === idx;
      pill.classList.toggle("active", isActive);
      pill.classList.toggle("done", i < idx);
      if (isActive) {
        pill.setAttribute("aria-current", "step");
      } else {
        pill.removeAttribute("aria-current");
      }
    });
  }

  if (!document.querySelector(".modal-backdrop.open")) {
    const heading = targetScreen?.querySelector("h1");
    if (heading) {
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
}

function updateHeaderPills() {
  const subtitleEl = document.getElementById("headerSubtitle");
  if (subtitleEl) subtitleEl.textContent = state.event.subtitle || "BGKV · STUDIO";

  const retentionBadge = document.getElementById("heroRetentionStat");
  if (retentionBadge) retentionBadge.textContent = `${state.event.retentionHours || 24}H`;

  const syncPill = document.getElementById("syncStatusPill");
  const syncText = document.getElementById("syncStatusText");
  if (syncPill && syncText) {
    if (state.queuePendingCount > 0) {
      syncPill.className = "header-pill is-queued";
      syncText.textContent = `${state.queuePendingCount} QUEUED · SYNC`;
    } else if (state.eventPass || state.boothToken) {
      syncPill.className = "header-pill is-unlocked";
      syncText.textContent = state.eventPass ? "PASS ACTIVE" : "BOOTH UNLOCKED";
    } else {
      syncPill.className = "header-pill is-synced";
      syncText.textContent = "CLOUD READY";
    }
    syncPill.disabled = state.queuePendingCount === 0;
  }
}

function applyEventBranding() {
  const titleEl = document.getElementById("footerBrand");
  if (titleEl) titleEl.textContent = `${state.event.title} · ${state.event.subtitle}`;
  const waiverBody = document.getElementById("waiverModalBody");
  if (waiverBody) waiverBody.textContent = state.event.waiverText;
  const waiverMeta = document.getElementById("waiverModalMeta");
  if (waiverMeta) {
    waiverMeta.textContent = `Waiver ${state.event.waiverVersion} · Ephemeral default ${state.event.retentionHours}h · Strictly Private QR`;
  }
  updateHeaderPills();
}

async function bootstrapEventFromUrl() {
  const params = new URLSearchParams(location.search);
  const passParam = params.get("pass");
  const eventParam = params.get("event");
  const guestToken = params.get("guest");

  let urlMutated = false;
  if (passParam) {
    setEventPass(passParam, eventParam || state.event.slug);
    params.delete("pass");
    urlMutated = true;
  }
  if (guestToken) {
    params.delete("guest");
    urlMutated = true;
  }
  if (urlMutated) {
    const clean = params.toString();
    history.replaceState({}, "", location.pathname + (clean ? `?${clean}` : ""));
  }

  try {
    const res = await edgeRequest("event-config", {
      query: { slug: eventParam || state.eventSlug || "" },
      timeoutMs: 8000,
    });
    if (res.event) {
      state.event = { ...state.event, ...res.event };
    }
  } catch {
    // Offline fallback uses DEFAULT_EVENT
  }

  applyEventBranding();

  if (guestToken) {
    openGuestDelivery(guestToken);
  }
}

function renderFilterGrid() {
  const host = document.getElementById("filterOptions");
  host.replaceChildren();

  for (const f of FILTERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `filter-tile${state.filter === f.id ? " selected" : ""}`;
    btn.dataset.filter = f.id;
    btn.setAttribute("aria-pressed", String(state.filter === f.id));

    const canvas = document.createElement("canvas");
    canvas.className = "filter-preview";
    canvas.setAttribute("aria-hidden", "true");
    canvas.width = 160;
    canvas.height = 184;
    drawStudioPortraitSample(canvas);
    applyPhotoFilter(canvas, f.id);

    const meta = document.createElement("span");
    meta.className = "filter-meta";
    const badge = document.createElement("span");
    badge.className = "filter-badge";
    badge.textContent = f.badge;
    const label = document.createElement("span");
    label.className = "filter-label";
    label.textContent = f.label;
    const small = document.createElement("small");
    small.textContent = f.desc;
    label.appendChild(small);
    meta.append(badge, label);

    btn.append(canvas, meta);
    btn.addEventListener("click", () => selectFilter(f.id));
    host.appendChild(btn);
  }
}

function renderLiveLensRail() {
  const rail = document.getElementById("liveLensRail");
  const resultRail = document.getElementById("resultLensRail");

  for (const container of [rail, resultRail]) {
    if (!container) continue;
    container.replaceChildren();
    for (const f of FILTERS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `lens-chip${state.filter === f.id ? " selected" : ""}`;
      chip.setAttribute("aria-pressed", String(state.filter === f.id));
      chip.textContent = f.label;
      chip.addEventListener("click", async () => {
        selectFilter(f.id);
        if (container === resultRail && state.rawCaptures.length) {
          await recompileResultFromRaw();
        }
      });
      container.appendChild(chip);
    }
  }
}

function selectFilter(id) {
  const found = FILTERS.find((f) => f.id === id) || FILTERS[0];
  state.filter = found.id;
  state.filterLabel = found.label;

  document.querySelectorAll("[data-filter]").forEach((b) => {
    const active = b.dataset.filter === found.id;
    b.classList.toggle("selected", active);
    b.setAttribute("aria-pressed", String(active));
  });

  const camBox = document.getElementById("cameraBox");
  if (camBox) camBox.dataset.look = found.id;
  const hudFilter = document.getElementById("hudFilterLabel");
  if (hudFilter) hudFilter.textContent = found.label.toUpperCase();

  renderLiveLensRail();
}

function renderThemeAndLayoutSelectors() {
  const themeHosts = [
    document.getElementById("stripThemeOptions"),
    document.getElementById("resultThemeOptions"),
  ];
  for (const host of themeHosts) {
    if (!host) continue;
    host.querySelectorAll("[data-theme]").forEach((btn) => {
      const active = btn.dataset.theme === state.theme;
      btn.classList.toggle("selected", active);
      btn.setAttribute("aria-pressed", String(active));
      btn.onclick = async () => {
        state.theme = btn.dataset.theme;
        renderThemeAndLayoutSelectors();
        if (state.screen === "resultScreen" && state.rawCaptures.length) {
          await recompileResultFromRaw();
        }
      };
    });
  }

  const layoutHosts = [
    document.getElementById("layoutOptions"),
    document.getElementById("resultLayoutOptions"),
  ];
  for (const host of layoutHosts) {
    if (!host) continue;
    host.replaceChildren();
    for (const l of LAYOUTS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `option-pill${state.layout === l.id ? " selected" : ""}`;
      btn.setAttribute("aria-pressed", String(state.layout === l.id));
      btn.textContent = l.label;
      btn.addEventListener("click", async () => {
        state.layout = l.id;
        renderThemeAndLayoutSelectors();
        if (state.screen === "resultScreen" && state.rawCaptures.length) {
          await recompileResultFromRaw();
        }
      });
      host.appendChild(btn);
    }
  }
}

function renderCameraFrameSlots() {
  const grid = document.getElementById("miniGrid");
  grid.replaceChildren();
  for (let i = 0; i < 4; i++) {
    const slot = document.createElement("div");
    slot.className = "frame-slot";
    const src = state.frameDataUrls[i];
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = `Frame 0${i + 1}`;
      const badge = document.createElement("span");
      badge.className = "frame-slot-badge";
      badge.textContent = `0${i + 1}`;
      slot.append(img, badge);
    } else {
      slot.textContent = `0${i + 1}`;
    }
    grid.appendChild(slot);
  }
}

function renderResultRetakeBar() {
  const bar = document.getElementById("resultRetakeBar");
  bar.replaceChildren();
  state.frameDataUrls.forEach((src, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "retake-thumb-btn";
    const img = document.createElement("img");
    img.src = src;
    img.alt = `Retake frame 0${i + 1}`;
    const label = document.createElement("span");
    label.textContent = `Retake 0${i + 1}`;
    btn.append(img, label);
    btn.addEventListener("click", () => retakeSingleSlot(i));
    bar.appendChild(btn);
  });
}

function resetResultDeliveryUi(bannerText = "Tap 'Sync / New QR ↗' to save to Supabase.") {
  state.currentSession = null;
  const qrHost = document.getElementById("qrCode");
  qrHost.replaceChildren();
  const qrHint = document.createElement("span");
  qrHint.className = "small-copy";
  qrHint.style.color = "#52525b";
  qrHint.textContent = "QR appears once synced.";
  qrHost.appendChild(qrHint);
  document.getElementById("shareExpiry").textContent = "Links expire automatically after retention window.";
  document.getElementById("copyLinkBtn").disabled = true;
  document.getElementById("deleteCloudBtn").disabled = true;
  setSyncBanner(bannerText, "");
}

async function openCameraScreen() {
  showScreen("cameraScreen");
  document.getElementById("cameraBox").dataset.look = state.filter;
  document.getElementById("hudFilterLabel").textContent = state.filterLabel.toUpperCase();
  document.getElementById("status").textContent = "REQUESTING CAMERA";
  document.getElementById("placeholderMsg").textContent = "Requesting camera access…";
  document.getElementById("captureBtn").disabled = true;
  document.getElementById("switchBtn").disabled = true;
  renderCameraFrameSlots();

  try {
    await startCamera({
      videoEl: document.getElementById("video"),
      placeholderEl: document.getElementById("placeholder"),
      hudCameraEl: document.getElementById("hudCameraLabel"),
      statusEl: document.getElementById("status"),
      onReady: () => {
        document.getElementById("captureBtn").disabled = false;
        document.getElementById("switchBtn").disabled = false;
      },
    });
  } catch (err) {
    document.getElementById("status").textContent = "CAMERA UNAVAILABLE";
    document.getElementById("placeholderMsg").textContent = err.message;
  }
}

async function startFullShoot() {
  const videoEl = document.getElementById("video");
  if (state.busy || !state.stream || !videoEl.videoWidth) return;

  abortActiveCapture();
  captureAbortController = new AbortController();
  const { signal } = captureAbortController;

  state.busy = true;
  state.rawCaptures = [];
  state.frameDataUrls = [];
  state.frameBlobs = [];
  state.extraRotation = 0;
  state.currentSession = null;

  document.getElementById("captureBtn").disabled = true;
  document.getElementById("switchBtn").disabled = true;
  document.getElementById("progressBar").style.transform = "scaleX(0)";
  document.getElementById("captureCount").textContent = "0 OF 4 PHOTOGRAPHS";
  renderCameraFrameSlots();

  const countdownEl = document.getElementById("countdown");
  const flashEl = document.getElementById("flash");

  try {
    for (let i = 0; i < 4; i++) {
      document.getElementById("instruction").textContent = `Frame ${i + 1} of 4 — hold your pose.`;
      await runCountdown(state.countdownSeconds, i, countdownEl, signal);
      await delay(250, signal);
      captureSlotFrame(videoEl, i, flashEl);
      if (i < 3) await rebuildFramesFromRaw();
      renderCameraFrameSlots();
      document.getElementById("captureCount").textContent = `${i + 1} OF 4 PHOTOGRAPHS`;
      document.getElementById("progressBar").style.transform = `scaleX(${(i + 1) * 0.25})`;
      await delay(450, signal);
    }

    document.getElementById("instruction").textContent = "Compiling high-resolution strip…";
    await compileAndShowResult();
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error(err);
      document.getElementById("status").textContent = "CAPTURE ERROR";
    }
  } finally {
    captureAbortController = null;
    state.busy = false;
    const hasStream = Boolean(state.stream);
    document.getElementById("captureBtn").disabled = !hasStream;
    document.getElementById("switchBtn").disabled = !hasStream;
  }
}

async function retakeSingleSlot(slotIndex) {
  await openCameraScreen();
  const videoEl = document.getElementById("video");
  if (!state.stream) return;

  abortActiveCapture();
  captureAbortController = new AbortController();
  const { signal } = captureAbortController;

  state.busy = true;
  document.getElementById("captureBtn").disabled = true;
  document.getElementById("switchBtn").disabled = true;
  document.getElementById("instruction").textContent = `Retaking frame 0${slotIndex + 1}…`;

  try {
    await runCountdown(state.countdownSeconds, slotIndex, document.getElementById("countdown"), signal);
    await delay(250, signal);
    captureSlotFrame(videoEl, slotIndex, document.getElementById("flash"));
    document.getElementById("instruction").textContent = "Compiling updated strip…";
    await compileAndShowResult();
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error(err);
      document.getElementById("status").textContent = "CAPTURE ERROR";
    }
  } finally {
    captureAbortController = null;
    state.busy = false;
    const hasStream = Boolean(state.stream);
    document.getElementById("captureBtn").disabled = !hasStream;
    document.getElementById("switchBtn").disabled = !hasStream;
  }
}

async function recompileResultFromRaw() {
  if (!state.rawCaptures.length) return;
  if (state.activeDraftLocalId) {
    await removeQueuedSession(state.activeDraftLocalId).catch(() => {});
    state.queuePendingCount = await countPendingQueue();
    updateHeaderPills();
  }
  state.activeDraftLocalId = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  resetResultDeliveryUi();

  await rebuildFramesFromRaw();
  const { dataUrl, blob } = await renderStripArtifact({
    frameDataUrls: state.frameDataUrls,
    themeId: state.theme,
    layoutType: state.layout,
    eventConfig: state.event,
    caption: state.caption,
  });
  state.stripDataUrl = dataUrl;
  state.stripBlob = blob;
  document.getElementById("resultImage").src = dataUrl;
  renderResultRetakeBar();
}

async function compileAndShowResult() {
  await recompileResultFromRaw();
  stopCamera(document.getElementById("video"), document.getElementById("placeholder"));
  showScreen("resultScreen");

  if (state.event.autoUpload) {
    await triggerAutoUpload();
  } else {
    setSyncBanner("Tap 'Sync / New QR ↗' to save to Supabase.", "");
  }
}

function setSyncBanner(text, modeClass = "") {
  const banner = document.getElementById("syncBanner");
  banner.textContent = text;
  banner.className = `sync-banner${modeClass ? ` ${modeClass}` : ""}`;
}

function promptPinModal() {
  return new Promise((resolve) => {
    pinBuffer = "";
    pinResolve = resolve;
    updatePinDots();
    document.getElementById("pinErrorMsg").textContent = "";
    const pinModal = document.getElementById("pinModal");
    openModal(pinModal, {
      initialFocus: document.querySelector('[data-pin-digit="1"]'),
      onCancel: () => {
        if (pinResolve) {
          pinResolve(null);
          pinResolve = null;
        }
        closeModal(pinModal);
      },
    });
  });
}

function updatePinDots() {
  document.querySelectorAll("#pinDots .pin-dot").forEach((dot, idx) => {
    dot.classList.toggle("filled", idx < pinBuffer.length);
  });
  const liveStatus = document.getElementById("pinLiveStatus");
  if (liveStatus) liveStatus.textContent = `${pinBuffer.length} of 8 digits entered`;
}

async function ensureUploadAuthorization() {
  if (state.event.openGuestAccess || state.eventPass || state.boothToken) return true;
  const pin = await promptPinModal();
  if (!pin) return false;
  const auth = await edgeRequest("booth-auth", { method: "POST", body: { pin } });
  setBoothToken(auth.boothToken);
  updateHeaderPills();
  return true;
}

async function triggerAutoUpload() {
  if (!state.stripBlob || state.uploading) return;
  state.uploading = true;
  document.getElementById("shareBtn").disabled = true;
  setSyncBanner("Preparing secure Supabase upload…", "is-uploading");

  if (!state.activeDraftLocalId) {
    state.activeDraftLocalId = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }
  const localId = state.activeDraftLocalId;
  const metadata = {
    filterId: state.filter,
    stripTheme: state.theme,
    layoutType: state.layout,
    caption: state.caption,
    collageConsent: state.collageConsent,
    waiverVersion: state.event.waiverVersion,
  };

  // Persist to IndexedDB immediately for offline safety
  await enqueueSession({
    localId,
    createdAt: Date.now(),
    stripBlob: state.stripBlob,
    frameBlobs: state.frameBlobs,
    metadata,
    status: "pending",
    attempts: 0,
  }).catch(() => {});
  state.queuePendingCount = await countPendingQueue();
  updateHeaderPills();

  const usedEventPass = Boolean(state.eventPass && !state.boothToken);

  try {
    const okAuth = await ensureUploadAuthorization();
    if (!okAuth) {
      throw new Error("Booth PIN cancelled. Photo saved in local queue.");
    }

    const res = await uploadSessionBundle({
      stripBlob: state.stripBlob,
      frameBlobs: state.frameBlobs,
      metadata,
      onProgress: (msg) => setSyncBanner(msg, "is-uploading"),
    });

    await removeQueuedSession(localId).catch(() => {});
    state.queuePendingCount = await countPendingQueue();
    updateHeaderPills();

    const guestLink = `${location.origin}${location.pathname}?guest=${encodeURIComponent(res.token)}`;
    if (localId === state.activeDraftLocalId) {
      state.currentSession = { ...res, guestLink };

      renderQrCode(document.getElementById("qrCode"), guestLink, 190);
      document.getElementById("copyLinkBtn").disabled = false;
      document.getElementById("deleteCloudBtn").disabled = false;
      document.getElementById("shareExpiry").textContent =
        `Code ${res.shortCode} · Expires ${new Date(res.expiresAt).toLocaleString()}`;
      setSyncBanner(
        `Synced! Strip + ${state.frameBlobs.length} frames stored privately (${res.shortCode}).`,
        "is-ready",
      );
    }
  } catch (err) {
    if (err.status === 401) {
      if (usedEventPass) {
        setEventPass("", "");
      } else {
        setBoothToken("");
      }
      updateHeaderPills();
    }
    setSyncBanner(`${err.message} Queued locally — auto-retries online.`, "is-queued");
  } finally {
    state.uploading = false;
    document.getElementById("shareBtn").disabled = false;
  }
}

async function flushOfflineQueue() {
  if (flushingQueue || state.uploading || !navigator.onLine) return;
  flushingQueue = true;
  try {
    const items = await listQueuedSessions();
    const pending = items.filter((i) => i.status !== "synced");
    for (const item of pending) {
      try {
        const res = await uploadSessionBundle({
          stripBlob: item.stripBlob,
          frameBlobs: item.frameBlobs,
          metadata: item.metadata,
        });
        await removeQueuedSession(item.localId);
        // Update result screen only if user is still viewing this exact draft
        if (state.screen === "resultScreen" && item.localId === state.activeDraftLocalId) {
          const guestLink = `${location.origin}${location.pathname}?guest=${encodeURIComponent(res.token)}`;
          state.currentSession = { ...res, guestLink };
          renderQrCode(document.getElementById("qrCode"), guestLink, 190);
          document.getElementById("copyLinkBtn").disabled = false;
          document.getElementById("deleteCloudBtn").disabled = false;
          document.getElementById("shareExpiry").textContent =
            `Code ${res.shortCode} · Expires ${new Date(res.expiresAt).toLocaleString()}`;
          setSyncBanner(`Synced from queue (${res.shortCode}).`, "is-ready");
        }
      } catch {
        // Keep in queue for next online event
      }
    }
  } finally {
    flushingQueue = false;
    state.queuePendingCount = await countPendingQueue();
    updateHeaderPills();
  }
}

async function openGuestDelivery(token) {
  showScreen("guestScreen");
  const statusEl = document.getElementById("guestExpiry");
  const imgEl = document.getElementById("guestImage");
  const dlEl = document.getElementById("guestDownload");
  const framesHost = document.getElementById("guestFramesGrid");
  const shareBtn = document.getElementById("guestShareBtn");
  const deleteBtn = document.getElementById("guestSelfDeleteBtn");

  imgEl.style.display = "none";
  dlEl.style.display = "none";
  shareBtn.style.display = "none";
  shareBtn.disabled = true;
  deleteBtn.style.display = "none";
  deleteBtn.disabled = true;
  framesHost.replaceChildren();
  statusEl.textContent = "Loading your private keepsake…";

  try {
    const data = await edgeRequest("guest", { method: "POST", body: { token } });
    imgEl.src = data.imageUrl;
    imgEl.style.display = "block";
    dlEl.href = data.downloadUrl;
    dlEl.style.display = "block";
    shareBtn.style.display = "";
    shareBtn.disabled = false;
    deleteBtn.style.display = "";
    deleteBtn.disabled = false;
    statusEl.textContent = `Session ${data.shortCode || ""} · Expires ${new Date(data.expiresAt).toLocaleString()}`;

    if (data.frames?.length) {
      for (const f of data.frames) {
        const card = document.createElement("div");
        card.className = "guest-frame-card";
        const fimg = document.createElement("img");
        fimg.src = f.viewUrl;
        fimg.alt = `Individual frame 0${f.index}`;
        const fdl = document.createElement("a");
        fdl.className = "secondary";
        fdl.href = f.downloadUrl;
        fdl.textContent = `Save Frame 0${f.index}`;
        fdl.style.textAlign = "center";
        fdl.style.textDecoration = "none";
        card.append(fimg, fdl);
        framesHost.appendChild(card);
      }
    }

    shareBtn.onclick = async () => {
      try {
        const res = await fetch(data.imageUrl);
        const blob = await res.blob();
        const file = new File([blob], `MiniSnap-${data.shortCode || "Memory"}.jpg`, { type: "image/jpeg" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: "My MiniSnap strip" });
        } else {
          statusEl.textContent = "Tap Download Strip to save directly to your camera roll.";
        }
      } catch {
        statusEl.textContent = "Tap Download Strip to save directly to your camera roll.";
      }
    };

    deleteBtn.onclick = async () => {
      if (!confirm("Delete your strip and all 4 frames from Supabase now?")) return;
      deleteBtn.disabled = true;
      let deleted = false;
      try {
        await edgeRequest("guest-delete", { method: "POST", body: { token } });
        deleted = true;
        imgEl.style.display = "none";
        dlEl.style.display = "none";
        shareBtn.style.display = "none";
        shareBtn.disabled = true;
        deleteBtn.style.display = "none";
        framesHost.replaceChildren();
        statusEl.textContent = "Your session and all stored photos have been permanently deleted.";
      } catch (err) {
        statusEl.textContent = err.message || "Failed to delete photos.";
      } finally {
        deleteBtn.disabled = deleted;
      }
    };
  } catch (err) {
    statusEl.textContent = err.message;
    dlEl.style.display = "none";
    shareBtn.style.display = "none";
    shareBtn.disabled = true;
    deleteBtn.style.display = "none";
    deleteBtn.disabled = true;
  }
}

function wireEvents() {
  document.getElementById("logoHomeBtn").addEventListener("click", () => {
    abortActiveCapture();
    state.busy = false;
    stopCamera(document.getElementById("video"), document.getElementById("placeholder"));
    showScreen("home");
  });

  document.getElementById("startHomeBtn").addEventListener("click", () => showScreen("setup"));
  document.getElementById("openCamBtn").addEventListener("click", openCameraScreen);
  document.getElementById("setupBackBtn").addEventListener("click", () => showScreen("home"));

  document.getElementById("captureBtn").addEventListener("click", startFullShoot);
  document.getElementById("switchBtn").addEventListener("click", async () => {
    if (state.busy) return;
    const prev = state.facing;
    state.facing = prev === "user" ? "environment" : "user";
    const captureBtn = document.getElementById("captureBtn");
    const switchBtn = document.getElementById("switchBtn");
    captureBtn.disabled = true;
    switchBtn.disabled = true;
    try {
      await startCamera({
        videoEl: document.getElementById("video"),
        placeholderEl: document.getElementById("placeholder"),
        hudCameraEl: document.getElementById("hudCameraLabel"),
        statusEl: document.getElementById("status"),
        onReady: () => {
          captureBtn.disabled = false;
          switchBtn.disabled = false;
        },
      });
    } catch (err) {
      state.facing = prev;
      document.getElementById("status").textContent = "CAMERA UNAVAILABLE";
      document.getElementById("placeholderMsg").textContent = err.message || "Could not switch camera.";
      captureBtn.disabled = !state.stream;
      switchBtn.disabled = !state.stream;
    }
  });

  document.getElementById("cancelCamBtn").addEventListener("click", () => {
    abortActiveCapture();
    state.busy = false;
    stopCamera(document.getElementById("video"), document.getElementById("placeholder"));
    showScreen("home");
  });

  document.getElementById("resumeCamBtn").addEventListener("click", openCameraScreen);

  document.getElementById("soundToggleBtn").addEventListener("click", (e) => {
    state.soundEnabled = !state.soundEnabled;
    e.currentTarget.textContent = state.soundEnabled ? "SOUND ON" : "MUTED";
  });

  const timerButtons = document.querySelectorAll("[data-timer]");
  timerButtons.forEach((btn) => {
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.timer) === state.countdownSeconds));
    btn.addEventListener("click", () => {
      state.countdownSeconds = Number(btn.dataset.timer);
      timerButtons.forEach((b) => {
        const active = b === btn;
        b.classList.toggle("selected", active);
        b.setAttribute("aria-pressed", String(active));
      });
    });
  });

  document.getElementById("captionInput").addEventListener("input", (e) => {
    state.caption = e.target.value.trim().slice(0, 60);
  });

  document.getElementById("waiverConsentCheck").addEventListener("change", (e) => {
    state.collageConsent = e.target.checked;
  });

  const waiverModal = document.getElementById("waiverModal");
  document.getElementById("openWaiverModalBtn").addEventListener("click", () => {
    openModal(waiverModal, { initialFocus: document.getElementById("closeWaiverModalBtn") });
  });
  document.getElementById("closeWaiverModalBtn").addEventListener("click", () => {
    closeModal(waiverModal);
  });

  document.getElementById("downloadStripBtn").addEventListener("click", () => {
    if (!state.stripDataUrl) return;
    const a = document.createElement("a");
    a.href = state.stripDataUrl;
    a.download = `MiniSnap-${state.currentSession?.shortCode || "Memory"}.jpg`;
    a.click();
  });

  document.getElementById("shareBtn").addEventListener("click", triggerAutoUpload);

  document.getElementById("copyLinkBtn").addEventListener("click", async () => {
    if (!state.currentSession?.guestLink) return;
    await navigator.clipboard.writeText(state.currentSession.guestLink).catch(() => {});
    setSyncBanner("Private guest link copied to clipboard.", "is-ready");
  });

  const deleteCloudBtn = document.getElementById("deleteCloudBtn");
  deleteCloudBtn.addEventListener("click", async () => {
    if (!state.currentSession?.token) return;
    if (!confirm("Delete this session and all 5 stored files from Supabase?")) return;
    deleteCloudBtn.disabled = true;
    try {
      await edgeRequest("guest-delete", {
        method: "POST",
        body: { token: state.currentSession.token },
      });
      resetResultDeliveryUi("Deleted from Supabase cloud storage.");
    } catch (err) {
      setSyncBanner(err.message || "Failed to delete from Supabase cloud storage.", "is-queued");
    } finally {
      deleteCloudBtn.disabled = !state.currentSession?.token;
    }
  });

  document.getElementById("rotatePlusBtn").addEventListener("click", async () => {
    state.extraRotation = (state.extraRotation + 90) % 360;
    await recompileResultFromRaw();
  });

  document.getElementById("rotateMinusBtn").addEventListener("click", async () => {
    state.extraRotation = (state.extraRotation + 270) % 360;
    await recompileResultFromRaw();
  });

  document.getElementById("retakeAllBtn").addEventListener("click", () => {
    state.rawCaptures = [];
    state.frameDataUrls = [];
    state.frameBlobs = [];
    state.activeDraftLocalId = "";
    resetResultDeliveryUi();
    openCameraScreen();
  });

  document.getElementById("doneResultBtn").addEventListener("click", () => {
    state.rawCaptures = [];
    state.frameDataUrls = [];
    state.frameBlobs = [];
    state.activeDraftLocalId = "";
    resetResultDeliveryUi();
    showScreen("home");
  });

  document.getElementById("syncStatusPill").addEventListener("click", () => {
    if (state.queuePendingCount > 0) flushOfflineQueue();
  });

  document.getElementById("openAdminBtn").addEventListener("click", () => {
    showScreen("adminScreen");
    loadAdminDashboard();
  });
  document.getElementById("backFromAdminBtn").addEventListener("click", () => showScreen("home"));

  // Keypad wiring
  const pinModal = document.getElementById("pinModal");
  document.querySelectorAll("[data-pin-digit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (pinBuffer.length >= 8) return;
      pinBuffer += btn.dataset.pinDigit;
      updatePinDots();
      if (pinBuffer.length === 8) {
        closeModal(pinModal);
        pinResolve?.(pinBuffer);
        pinResolve = null;
      }
    });
  });
  document.getElementById("pinBackBtn").addEventListener("click", () => {
    pinBuffer = pinBuffer.slice(0, -1);
    updatePinDots();
  });
  document.getElementById("pinCancelBtn").addEventListener("click", () => {
    closeModal(pinModal);
    pinResolve?.(null);
    pinResolve = null;
  });

  // Tab visibility auto-recovery
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      abortActiveCapture();
      if (state.stream) stopCamera(document.getElementById("video"), document.getElementById("placeholder"));
    } else if (state.screen === "cameraScreen" && !state.busy && !state.stream) {
      openCameraScreen();
    }
  });

  window.addEventListener("online", flushOfflineQueue);
  window.addEventListener("pagehide", () =>
    stopCamera(document.getElementById("video"), document.getElementById("placeholder")),
  );
}

async function init() {
  renderFilterGrid();
  renderLiveLensRail();
  renderThemeAndLayoutSelectors();
  wireEvents();
  initAdminUI({ onEventUpdated: applyEventBranding });
  initHomepageMotion();

  state.queuePendingCount = await countPendingQueue();
  updateHeaderPills();

  await bootstrapEventFromUrl();
  if (navigator.onLine && state.queuePendingCount > 0) {
    flushOfflineQueue();
  }
}

init();
