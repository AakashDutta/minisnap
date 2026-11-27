import { setAdminKey, state } from "./state.js";
import { edgeRequest } from "./supabase-api.js";
import { closeModal, openModal } from "./modal.js";

let adminTab = "sessions"; // sessions | collage | settings
let sessionFilter = "all"; // all | active | collage | archived | expired
let searchQuery = "";
let lastAdminData = null;
let selectedCollageIds = new Set();
let onEventUpdatedCallback = null;
let sessionOffset = 0;
let loadedSessions = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return mb < 0.1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`;
}

function formatExpiryBadge(s) {
  if (s.is_archived) return { text: "Archived", cls: "archived" };
  const diffMs = new Date(s.expires_at).getTime() - Date.now();
  if (diffMs <= 0) return { text: "Expired", cls: "expired" };
  const hrs = Math.floor(diffMs / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  return { text: hrs > 0 ? `${hrs}h ${mins}m left` : `${mins}m left`, cls: "" };
}

export function renderQrCode(container, text, size = 180) {
  container.replaceChildren();
  if (typeof window.QRCode === "undefined") {
    const p = el("p", "small-copy", text);
    p.style.color = "#09090b";
    p.style.wordBreak = "break-all";
    container.appendChild(p);
    return;
  }
  new window.QRCode(container, {
    text,
    width: size,
    height: size,
    colorDark: "#09090b",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M,
  });
}

function renderStats(stats) {
  const host = document.getElementById("adminStats");
  host.replaceChildren();
  const items = [
    ["Active Sessions", stats.activeSessions],
    ["Storage Used", formatBytes(stats.totalBytes)],
    ["Guest Opens", stats.totalGuestOpens],
    ["Collage Approved", stats.collageApproved],
    ["Expiring < 2h", stats.expiringSoon],
  ];
  for (const [label, value] of items) {
    const card = el("div", "stat-card");
    card.append(el("span", "", label), el("strong", "", value));
    host.appendChild(card);
  }
}

function renderLoadingSkeletons() {
  const host = document.getElementById("adminContent");
  host.replaceChildren();
  const grid = el("div", "sessions-grid");
  for (let i = 0; i < 6; i++) {
    grid.appendChild(el("div", "skeleton-card"));
  }
  host.appendChild(grid);
}

function renderSessionsTab(data) {
  const host = document.getElementById("adminContent");
  host.replaceChildren();

  const toolbar = el("div", "admin-toolbar");
  const filters = el("div", "admin-filter-group");
  const filterDefs = [
    ["all", "All"],
    ["active", "Active"],
    ["collage", "Collage Approved"],
    ["archived", "Archived"],
    ["expired", "Expired"],
  ];

  for (const [key, label] of filterDefs) {
    const btn = el("button", `option-pill${sessionFilter === key ? " selected" : ""}`, label);
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(sessionFilter === key));
    btn.addEventListener("click", () => {
      sessionFilter = key;
      sessionOffset = 0;
      loadAdminDashboard();
    });
    filters.appendChild(btn);
  }

  const search = el("input", "field admin-search");
  search.type = "search";
  search.placeholder = "Search code (MS-XXXX) or caption…";
  search.setAttribute("aria-label", "Search sessions by code or caption");
  search.value = searchQuery;
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      searchQuery = search.value.trim();
      sessionOffset = 0;
      loadAdminDashboard();
    }
  });

  const searchBtn = el("button", "option-pill", "Search");
  searchBtn.type = "button";
  searchBtn.addEventListener("click", () => {
    searchQuery = search.value.trim();
    sessionOffset = 0;
    loadAdminDashboard();
  });

  toolbar.append(filters, search, searchBtn);
  host.appendChild(toolbar);

  const sessions = loadedSessions;
  if (!sessions.length) {
    const empty = el("div", "card");
    empty.append(
      el("h2", "card-title", "NO MATCHING SESSIONS"),
      el("p", "card-copy", "No sessions match the current filter. Adjust filters or capture a strip in the studio."),
    );
    host.appendChild(empty);
    return;
  }

  const grid = el("div", "sessions-grid");
  for (const s of sessions) {
    const card = el("article", "session-card");

    if (s.thumbUrl) {
      const img = el("img", "session-thumb");
      img.src = s.thumbUrl;
      img.alt = `Strip ${s.short_code || ""}`;
      img.loading = "lazy";
      card.appendChild(img);
    }

    const top = el("div", "session-meta-top");
    top.appendChild(el("span", "code-chip", s.short_code || s.id.slice(0, 6)));
    top.appendChild(el("span", "small-copy", formatBytes(s.total_bytes)));
    card.appendChild(top);

    const tags = el("div", "tag-row");
    tags.appendChild(el("span", "tag-pill", s.filter_id || "none"));
    tags.appendChild(el("span", "tag-pill", `${s.frameCount || 0} frames`));
    const exp = formatExpiryBadge(s);
    tags.appendChild(el("span", `tag-pill ${exp.cls}`, exp.text));
    if (s.collage_consent) tags.appendChild(el("span", "tag-pill consent", "Collage OK"));
    card.appendChild(tags);

    if (s.caption) {
      card.appendChild(el("p", "small-copy", `"${s.caption}"`));
    }

    card.appendChild(
      el(
        "p",
        "small-copy",
        `${new Date(s.created_at).toLocaleString()} · ${s.guest_access_count || 0} opens`,
      ),
    );

    const inspectBtn = el("button", "secondary", "Inspect & Manage");
    inspectBtn.type = "button";
    inspectBtn.addEventListener("click", () => openSessionInspector(s.id));
    card.appendChild(inspectBtn);

    grid.appendChild(card);
  }
  host.appendChild(grid);

  if (data.hasMore) {
    const moreWrap = el("div", "actions");
    moreWrap.style.marginTop = "16px";
    const loadMoreBtn = el("button", "secondary", "Load More Sessions");
    loadMoreBtn.type = "button";
    loadMoreBtn.addEventListener("click", async () => {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = "Loading…";
      await loadAdminDashboard({ append: true });
    });
    moreWrap.appendChild(loadMoreBtn);
    host.appendChild(moreWrap);
  }
}

async function openSessionInspector(sessionId) {
  const modal = document.getElementById("inspectorModal");
  const body = document.getElementById("inspectorBody");
  body.replaceChildren(el("p", "small-copy", "Loading session details…"));
  openModal(modal, { initialFocus: document.getElementById("closeInspectorBtn") });

  try {
    const res = await edgeRequest("admin-session", {
      adminKey: state.adminKey,
      query: { id: sessionId },
    });
    const s = res.session;
    body.replaceChildren();

    const header = el("div", "session-meta-top");
    header.append(
      el("span", "code-chip", s.short_code || s.id.slice(0, 8)),
      el("span", "small-copy", formatBytes(s.total_bytes)),
    );
    body.appendChild(header);

    if (s.stripUrl) {
      const stripImg = el("img", "result-image");
      stripImg.src = s.stripUrl;
      stripImg.alt = "Full strip preview";
      stripImg.style.maxWidth = "220px";
      body.appendChild(stripImg);
    }

    if (s.frames?.length) {
      body.appendChild(el("h2", "card-title", `INDIVIDUAL FRAMES (${s.frames.length})`));
      const fgrid = el("div", "guest-frames-grid");
      for (const f of s.frames) {
        const fc = el("div", "guest-frame-card");
        const img = el("img");
        img.src = f.viewUrl;
        img.alt = `Frame ${f.index}`;
        const dl = el("a", "secondary", `Frame 0${f.index} ↓`);
        dl.href = f.downloadUrl;
        dl.style.textAlign = "center";
        dl.style.textDecoration = "none";
        fc.append(img, dl);
        fgrid.appendChild(fc);
      }
      body.appendChild(fgrid);
    }

    const qrBox = el("div", "qr-wrap");
    qrBox.style.display = "none";
    const qrTarget = el("div");
    qrBox.appendChild(qrTarget);
    body.appendChild(qrBox);

    const actionWrap = el("div", "actions");
    const inspectorError = el("p", "small-copy", "");
    inspectorError.style.color = "var(--rec)";
    inspectorError.setAttribute("role", "status");
    inspectorError.setAttribute("aria-live", "polite");

    if (s.stripDownloadUrl) {
      const dlStrip = el("a", "primary", "Download Strip ↓");
      dlStrip.href = s.stripDownloadUrl;
      dlStrip.style.display = "block";
      dlStrip.style.textAlign = "center";
      dlStrip.style.textDecoration = "none";
      actionWrap.appendChild(dlStrip);
    }

    const reissueBtn = el("button", "secondary", "Re-issue Fresh Guest QR");
    reissueBtn.type = "button";
    reissueBtn.addEventListener("click", async () => {
      reissueBtn.disabled = true;
      reissueBtn.textContent = "Generating…";
      inspectorError.textContent = "";
      try {
        const re = await edgeRequest("admin-reissue", {
          method: "POST",
          adminKey: state.adminKey,
          body: { id: s.id },
        });
        const guestUrl = `${location.origin}${location.pathname}?guest=${encodeURIComponent(re.token)}`;
        qrBox.style.display = "grid";
        renderQrCode(qrTarget, guestUrl, 180);
        await navigator.clipboard?.writeText(guestUrl).catch(() => {});
        reissueBtn.textContent = "Fresh QR Ready & Link Copied";
      } catch (err) {
        reissueBtn.textContent = "Re-issue Fresh Guest QR";
        inspectorError.textContent = err.message || "Failed to re-issue guest QR.";
      } finally {
        reissueBtn.disabled = false;
      }
    });
    actionWrap.appendChild(reissueBtn);

    const row1 = el("div", "actions-row");
    const archiveBtn = el("button", "secondary", s.is_archived ? "Unarchive" : "Archive / Pin");
    archiveBtn.type = "button";

    const extendBtn = el("button", "secondary", "Extend +24h");
    extendBtn.type = "button";

    row1.append(archiveBtn, extendBtn);
    actionWrap.appendChild(row1);

    let revokeBtn = null;
    if (s.collage_consent) {
      revokeBtn = el("button", "secondary", "Revoke Collage Consent");
      revokeBtn.type = "button";
      actionWrap.appendChild(revokeBtn);
    }

    const delBtn = el("button", "secondary danger-btn", "Delete Session & All Files");
    delBtn.type = "button";
    actionWrap.appendChild(delBtn);
    actionWrap.appendChild(inspectorError);

    const inspectorButtons = [reissueBtn, archiveBtn, extendBtn, delBtn];
    if (revokeBtn) inspectorButtons.push(revokeBtn);

    const runInspectorAction = async (fn) => {
      inspectorError.textContent = "";
      inspectorButtons.forEach((b) => {
        b.disabled = true;
      });
      let succeeded = false;
      try {
        await fn();
        succeeded = true;
        closeModal(modal);
        loadAdminDashboard();
      } catch (err) {
        inspectorError.textContent = err.message || "Action failed. Please try again.";
      } finally {
        if (!succeeded) {
          inspectorButtons.forEach((b) => {
            b.disabled = false;
          });
        }
      }
    };

    archiveBtn.addEventListener("click", () =>
      runInspectorAction(() =>
        edgeRequest("admin-update", {
          method: "POST",
          adminKey: state.adminKey,
          body: { id: s.id, isArchived: !s.is_archived },
        }),
      ),
    );

    extendBtn.addEventListener("click", () =>
      runInspectorAction(() =>
        edgeRequest("admin-update", {
          method: "POST",
          adminKey: state.adminKey,
          body: { id: s.id, extendHours: 24 },
        }),
      ),
    );

    if (revokeBtn) {
      revokeBtn.addEventListener("click", () =>
        runInspectorAction(() =>
          edgeRequest("admin-update", {
            method: "POST",
            adminKey: state.adminKey,
            body: { id: s.id, collageConsent: false },
          }),
        ),
      );
    }

    delBtn.addEventListener("click", () => {
      if (!confirm(`Permanently delete ${s.short_code || "this session"} and all stored files?`)) return;
      return runInspectorAction(() =>
        edgeRequest("admin-delete", {
          method: "POST",
          adminKey: state.adminKey,
          body: { id: s.id },
        }),
      );
    });

    body.appendChild(actionWrap);
  } catch (err) {
    body.replaceChildren(el("p", "small-copy", err.message));
  }
}

async function fetchImageUntainted(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(objUrl);
      reject(e);
    };
    img.src = objUrl;
  });
}

async function buildEventCollagePoster(sessions, eventCfg) {
  const selected = sessions.filter((s) => selectedCollageIds.has(s.id) && s.thumbUrl);
  if (!selected.length) return null;

  const cols = selected.length <= 4 ? 2 : selected.length <= 9 ? 3 : 4;
  const rows = Math.ceil(selected.length / cols);
  const W = 2400;
  const pad = 80;
  const gap = 34;
  const headerH = 260;
  const footerH = 150;
  const cellW = Math.floor((W - pad * 2 - gap * (cols - 1)) / cols);
  const cellH = Math.round(cellW * 1.45);
  const H = headerH + rows * cellH + Math.max(0, rows - 1) * gap + footerH;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#111114";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 4;
  ctx.strokeRect(36, 36, W - 72, H - 72);

  ctx.textAlign = "center";
  ctx.fillStyle = "#fafafa";
  ctx.font = "700 68px 'Space Grotesk', Arial, sans-serif";
  ctx.fillText(eventCfg.title || "MINISNAP EVENT COLLAGE", W / 2, 132);
  ctx.fillStyle = "#a1a1aa";
  ctx.font = "500 28px 'JetBrains Mono', Arial, sans-serif";
  ctx.fillText(`${eventCfg.subtitle || "BGKV · STUDIO"} · ${selected.length} CONSENTED SESSIONS`, W / 2, 188);

  const imgs = await Promise.all(selected.map((s) => fetchImageUntainted(s.thumbUrl)));
  imgs.forEach((img, idx) => {
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    const x = pad + c * (cellW + gap);
    const y = headerH + r * (cellH + gap);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, cellW, cellH, 16);
    ctx.clip();
    const scale = Math.max(cellW / img.width, cellH / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
    ctx.restore();
  });

  ctx.fillStyle = "#a1a1aa";
  ctx.font = "500 26px 'JetBrains Mono', Arial, sans-serif";
  ctx.fillText(eventCfg.footerText || "BGKV × MINISNAP", W / 2, H - 72);
  return canvas;
}

function renderCollageTab(data) {
  const host = document.getElementById("adminContent");
  host.replaceChildren();

  const consented = data.sessions.filter((s) => s.collage_consent);
  const consentedIds = new Set(consented.map((s) => s.id));
  for (const id of [...selectedCollageIds]) {
    if (!consentedIds.has(id)) selectedCollageIds.delete(id);
  }

  const info = el("div", "card");
  info.style.marginTop = "0";
  info.append(
    el("h2", "card-title", "PRIVACY-COMPLIANT COLLAGE VAULT"),
    el(
      "p",
      "card-copy",
      "Only sessions where the guest explicitly opted into the All-Inclusive Event Collage Waiver appear here. Guest QR links remain private.",
    ),
  );
  host.appendChild(info);

  if (!consented.length) {
    const empty = el("div", "card");
    empty.append(
      el("h2", "card-title", "NO CONSENTED SESSIONS YET"),
      el("p", "card-copy", "Sessions opted into the event collage waiver will appear here for curation."),
    );
    host.appendChild(empty);
    return;
  }

  const bar = el("div", "admin-toolbar");
  const selectAllBtn = el("button", "option-pill", "Select All");
  selectAllBtn.type = "button";
  selectAllBtn.addEventListener("click", () => {
    consented.forEach((s) => selectedCollageIds.add(s.id));
    renderCollageTab(data);
  });

  const clearBtn = el("button", "option-pill", "Clear");
  clearBtn.type = "button";
  clearBtn.addEventListener("click", () => {
    selectedCollageIds.clear();
    renderCollageTab(data);
  });

  const buildBtn = el("button", "primary", `Build Collage Poster (${selectedCollageIds.size})`);
  buildBtn.type = "button";
  buildBtn.style.width = "auto";
  buildBtn.disabled = selectedCollageIds.size === 0;

  bar.append(selectAllBtn, clearBtn, buildBtn);
  host.appendChild(bar);

  const collageError = el("p", "small-copy", "");
  collageError.style.color = "var(--rec)";
  collageError.setAttribute("role", "status");
  collageError.setAttribute("aria-live", "polite");
  host.appendChild(collageError);

  const previewWrap = el("div", "collage-preview-wrap");
  previewWrap.style.display = "none";
  host.appendChild(previewWrap);

  buildBtn.addEventListener("click", async () => {
    buildBtn.disabled = true;
    buildBtn.textContent = "Rendering Poster…";
    collageError.textContent = "";
    try {
      const canvas = await buildEventCollagePoster(consented, data.event);
      if (canvas) {
        previewWrap.replaceChildren();
        previewWrap.style.display = "grid";
        canvas.id = "collageCanvasPreview";
        const dl = el("a", "primary", "Download Event Collage Poster (JPEG) ↓");
        dl.href = canvas.toDataURL("image/jpeg", 0.92);
        dl.download = `MiniSnap-Event-Collage-${Date.now()}.jpg`;
        dl.style.display = "block";
        dl.style.textAlign = "center";
        dl.style.textDecoration = "none";
        previewWrap.append(canvas, dl);
      }
    } catch (err) {
      collageError.textContent = err.message || "Failed to build collage poster.";
    } finally {
      buildBtn.disabled = selectedCollageIds.size === 0;
      buildBtn.textContent = `Build Collage Poster (${selectedCollageIds.size})`;
    }
  });

  const grid = el("div", "sessions-grid");
  for (const s of consented) {
    const card = el("article", "session-card");
    const picked = selectedCollageIds.has(s.id);
    if (picked) card.style.borderColor = "var(--ready)";

    if (s.thumbUrl) {
      const img = el("img", "session-thumb");
      img.src = s.thumbUrl;
      img.alt = s.short_code || "Collage photo";
      card.appendChild(img);
    }

    const row = el("div", "session-meta-top");
    row.append(
      el("span", "code-chip", s.short_code || s.id.slice(0, 6)),
      el("span", "tag-pill consent", s.is_archived ? "Pinned" : "Consented"),
    );
    card.appendChild(row);

    const toggleBtn = el("button", picked ? "primary" : "secondary", picked ? "Selected ✓" : "Select for Collage");
    toggleBtn.type = "button";
    toggleBtn.setAttribute("aria-pressed", String(picked));
    toggleBtn.addEventListener("click", () => {
      if (selectedCollageIds.has(s.id)) selectedCollageIds.delete(s.id);
      else selectedCollageIds.add(s.id);
      renderCollageTab(data);
    });
    card.appendChild(toggleBtn);
    grid.appendChild(card);
  }
  host.appendChild(grid);
}

function renderSettingsTab(data) {
  const host = document.getElementById("adminContent");
  host.replaceChildren();
  const ev = data.event || {};

  const card = el("div", "card");
  card.style.marginTop = "0";
  card.appendChild(el("h2", "card-title", "EVENT & EPHEMERAL RETENTION CONFIG"));

  const formGrid = el("div", "admin-form-grid");

  const makeInput = (label, id, value, type = "text") => {
    const wrap = el("div", "form-field");
    const lbl = el("label", "", label);
    lbl.htmlFor = id;
    const inp = el("input", "field");
    inp.id = id;
    inp.type = type;
    inp.value = value ?? "";
    wrap.append(lbl, inp);
    return { wrap, inp };
  };

  const titleF = makeInput("Event Title", "cfgTitle", ev.title);
  const subF = makeInput("Subtitle / Venue", "cfgSubtitle", ev.subtitle);
  const footF = makeInput("Strip Footer Text", "cfgFooter", ev.footerText);
  const retF = makeInput("Retention Hours (1 – 8760)", "cfgRetention", ev.retentionHours ?? 24, "number");
  retF.inp.min = "1";
  retF.inp.max = "8760";

  formGrid.append(titleF.wrap, subF.wrap, footF.wrap, retF.wrap);
  card.appendChild(formGrid);

  const waiverWrap = el("div", "form-field");
  waiverWrap.style.marginTop = "14px";
  const waiverLbl = el("label", "", "All-Inclusive Privacy Waiver Text");
  waiverLbl.htmlFor = "cfgWaiver";
  const waiverTxt = el("textarea", "field");
  waiverTxt.id = "cfgWaiver";
  waiverTxt.value = ev.waiverText || "";
  waiverWrap.append(waiverLbl, waiverTxt);
  card.appendChild(waiverWrap);

  const checksWrap = el("div", "actions");
  const autoCheck = el("label", "waiver-check-row");
  const autoBox = el("input");
  autoBox.type = "checkbox";
  autoBox.checked = ev.autoUpload !== false;
  autoCheck.append(autoBox, el("span", "waiver-summary", "Auto-upload strips & frames immediately after capture"));

  const openCheck = el("label", "waiver-check-row");
  const openBox = el("input");
  openBox.type = "checkbox";
  openBox.checked = ev.openGuestAccess !== false;
  openCheck.append(
    openBox,
    el(
      "span",
      "waiver-summary",
      "Allow personal phones without Event Pass QR (rate-limited per IP)",
    ),
  );
  checksWrap.append(autoCheck, openCheck);
  card.appendChild(checksWrap);

  const saveStatus = el("p", "small-copy", "");
  saveStatus.style.marginTop = "10px";
  saveStatus.setAttribute("role", "status");
  saveStatus.setAttribute("aria-live", "polite");

  const saveBtn = el("button", "primary", "Save Event Settings");
  saveBtn.type = "button";
  saveBtn.style.marginTop = "14px";
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveStatus.textContent = "Saving settings…";
    const nextEvent = {
      title: titleF.inp.value,
      subtitle: subF.inp.value,
      footerText: footF.inp.value,
      retentionHours: Number(retF.inp.value || 24),
      autoUpload: autoBox.checked,
      openGuestAccess: openBox.checked,
      waiverText: waiverTxt.value,
    };
    try {
      await edgeRequest("admin-event", {
        method: "POST",
        adminKey: state.adminKey,
        body: nextEvent,
      });
      state.event = {
        ...state.event,
        title: nextEvent.title,
        subtitle: nextEvent.subtitle,
        footerText: nextEvent.footerText,
        retentionHours: nextEvent.retentionHours,
        autoUpload: nextEvent.autoUpload,
        openGuestAccess: nextEvent.openGuestAccess,
        waiverText: nextEvent.waiverText,
      };
      onEventUpdatedCallback?.();
      saveStatus.textContent = "Settings saved to Supabase.";
      await loadAdminDashboard();
    } catch (err) {
      saveStatus.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });
  card.append(saveBtn, saveStatus);
  host.appendChild(card);

  // Venue Event Pass QR card
  const passCard = el("div", "card");
  passCard.append(
    el("h2", "card-title", "VENUE POSTER QR (PERSONAL PHONES)"),
    el(
      "p",
      "card-copy",
      "Print or display this signed Event Pass QR at your booth. Guests scan it on their personal phones for instant auto-upload without entering any PIN.",
    ),
  );
  const qrWrap = el("div", "qr-wrap");
  qrWrap.style.display = "none";
  const qrInner = el("div");
  qrWrap.appendChild(qrInner);
  const passLinkText = el("p", "small-copy", "");
  const passBtn = el("button", "secondary", "Generate 48h Venue Event Pass QR");
  passBtn.type = "button";
  passBtn.style.marginTop = "12px";
  passBtn.addEventListener("click", async () => {
    passBtn.disabled = true;
    try {
      const res = await edgeRequest("admin-event-pass", {
        method: "POST",
        adminKey: state.adminKey,
        body: { hours: 48 },
      });
      const url = `${location.origin}${location.pathname}?event=${encodeURIComponent(res.slug)}&pass=${encodeURIComponent(res.passToken)}`;
      qrWrap.style.display = "grid";
      renderQrCode(qrInner, url, 200);
      passLinkText.textContent = url;
      passLinkText.style.wordBreak = "break-all";
      await navigator.clipboard?.writeText(url).catch(() => {});
    } catch (err) {
      passLinkText.textContent = err.message;
    } finally {
      passBtn.disabled = false;
    }
  });
  passCard.append(passBtn, qrWrap, passLinkText);
  host.appendChild(passCard);

  // Storage Purge card
  const purgeCard = el("div", "card");
  purgeCard.append(
    el("h2", "card-title", "STORAGE CLEANUP"),
    el("p", "card-copy", "Purge all expired non-archived sessions and remove their strip + 4-frame files from Supabase Storage."),
  );
  const purgeStatus = el("p", "small-copy", "");
  purgeStatus.setAttribute("role", "status");
  purgeStatus.setAttribute("aria-live", "polite");
  const purgeBtn = el("button", "secondary danger-btn", "Purge Expired Sessions Now");
  purgeBtn.type = "button";
  purgeBtn.style.marginTop = "12px";
  purgeBtn.addEventListener("click", async () => {
    purgeBtn.disabled = true;
    purgeStatus.textContent = "Purging expired sessions…";
    try {
      const res = await edgeRequest("delete-expired", {
        method: "POST",
        adminKey: state.adminKey,
        body: {},
      });
      purgeStatus.textContent = `${res.deleted} expired session(s) deleted (${res.filesRemoved || 0} files removed).`;
      await loadAdminDashboard();
    } catch (err) {
      purgeStatus.textContent = err.message;
    } finally {
      purgeBtn.disabled = false;
    }
  });
  purgeCard.append(purgeBtn, purgeStatus);
  host.appendChild(purgeCard);
}

export async function loadAdminDashboard(opts) {
  const append = opts?.append === true && adminTab === "sessions";
  const keyInput = document.getElementById("adminKey");
  const typedKey = keyInput?.value.trim();
  if (typedKey) setAdminKey(typedKey);

  const statusEl = document.getElementById("adminStatus");
  if (!state.adminKey) {
    statusEl.textContent = "Enter your operator admin key to unlock the Control Room.";
    return;
  }

  if (!append) {
    sessionOffset = 0;
    renderLoadingSkeletons();
  }
  statusEl.textContent = "Syncing with Supabase…";

  try {
    const filterToSend = adminTab === "collage" ? "collage" : sessionFilter;
    const limit = adminTab === "collage" ? 100 : 48;
    const query = { filter: filterToSend, q: searchQuery, limit };
    if (append) query.offset = sessionOffset;

    const data = await edgeRequest("admin", {
      adminKey: state.adminKey,
      query,
    });
    lastAdminData = data;
    if (data.event) {
      state.event = { ...state.event, ...data.event };
      onEventUpdatedCallback?.();
    }
    if (append) {
      const existingIds = new Set(loadedSessions.map((s) => s.id));
      const fresh = (data.sessions || []).filter((s) => !existingIds.has(s.id));
      loadedSessions = [...loadedSessions, ...fresh];
    } else {
      loadedSessions = data.sessions || [];
    }
    sessionOffset = loadedSessions.length;

    document.getElementById("adminAuthCard").style.display = "none";
    document.getElementById("adminWorkspace").style.display = "grid";
    statusEl.textContent = `Connected · ${data.stats.totalSessions} total session(s)`;
    renderStats(data.stats);

    if (adminTab === "sessions") renderSessionsTab(data);
    else if (adminTab === "collage") renderCollageTab(data);
    else renderSettingsTab(data);
  } catch (err) {
    statusEl.textContent = err.message;
    if (err.status === 401) {
      setAdminKey("");
      document.getElementById("adminAuthCard").style.display = "block";
      document.getElementById("adminWorkspace").style.display = "none";
    }
    if (!append) {
      const host = document.getElementById("adminContent");
      host.replaceChildren();
      const errCard = el("div", "card");
      errCard.append(el("h2", "card-title", "LOAD FAILED"), el("p", "card-copy", err.message));
      host.appendChild(errCard);
    }
  }
}

export function initAdminUI({ onEventUpdated } = {}) {
  onEventUpdatedCallback = onEventUpdated || null;

  const tabs = Array.from(document.querySelectorAll("[data-admin-tab]"));
  const activateTab = (tabBtn, { focus = false } = {}) => {
    adminTab = tabBtn.dataset.adminTab;
    sessionOffset = 0;
    tabs.forEach((b) => {
      const active = b === tabBtn;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    });
    if (focus) tabBtn.focus();
    loadAdminDashboard();
  };

  tabs.forEach((btn, idx) => {
    btn.setAttribute("aria-selected", String(btn.dataset.adminTab === adminTab));
    btn.addEventListener("click", () => activateTab(btn));
    btn.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const nextIdx = e.key === "ArrowRight" ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
      activateTab(tabs[nextIdx], { focus: true });
    });
  });

  document.getElementById("adminLoginBtn")?.addEventListener("click", () => loadAdminDashboard());
  document.getElementById("adminRefreshBtn")?.addEventListener("click", () => loadAdminDashboard());
  document.getElementById("adminSignOutBtn")?.addEventListener("click", () => {
    setAdminKey("");
    lastAdminData = null;
    sessionOffset = 0;
    loadedSessions = [];
    selectedCollageIds.clear();
    document.getElementById("adminKey").value = "";
    document.getElementById("adminAuthCard").style.display = "block";
    document.getElementById("adminWorkspace").style.display = "none";
    document.getElementById("adminStatus").textContent = "Signed out.";
  });

  document.getElementById("closeInspectorBtn")?.addEventListener("click", () => {
    closeModal(document.getElementById("inspectorModal"));
  });
}
