import { DEFAULT_EVENT } from "./config.js";

const STORAGE_KEYS = {
  boothToken: "minisnap_booth_token",
  eventPass: "minisnap_event_pass",
  eventSlug: "minisnap_event_slug",
  adminKey: "minisnap_admin_key",
};

export const state = {
  screen: "home",
  event: { ...DEFAULT_EVENT },
  boothToken: sessionStorage.getItem(STORAGE_KEYS.boothToken) || "",
  eventPass: localStorage.getItem(STORAGE_KEYS.eventPass) || "",
  eventSlug: localStorage.getItem(STORAGE_KEYS.eventSlug) || "",
  adminKey: sessionStorage.getItem(STORAGE_KEYS.adminKey) || "",

  // Camera & capture state
  stream: null,
  facing: "user",
  busy: false,
  soundEnabled: true,
  countdownSeconds: 5,
  wakeLock: null,

  // Session creative state
  filter: "none",
  filterLabel: "Studio Clean",
  theme: "pink",
  layout: "strip-4",
  caption: "",
  collageConsent: false,
  extraRotation: 0,
  rawCaptures: [], // [{ canvas, mirror }]
  frameDataUrls: [],
  frameBlobs: [],
  stripDataUrl: "",
  stripBlob: null,

  // Cloud delivery state
  currentSession: null, // { sessionId, shortCode, token, guestLink, expiresAt }
  activeDraftLocalId: "",
  uploading: false,
  queuePendingCount: 0,
};

export function setBoothToken(token) {
  state.boothToken = token || "";
  if (state.boothToken) {
    sessionStorage.setItem(STORAGE_KEYS.boothToken, state.boothToken);
  } else {
    sessionStorage.removeItem(STORAGE_KEYS.boothToken);
  }
}

export function setEventPass(pass, slug = "") {
  state.eventPass = pass || "";
  state.eventSlug = slug || "";
  if (state.eventPass) {
    localStorage.setItem(STORAGE_KEYS.eventPass, state.eventPass);
    if (slug) localStorage.setItem(STORAGE_KEYS.eventSlug, slug);
  } else {
    localStorage.removeItem(STORAGE_KEYS.eventPass);
    localStorage.removeItem(STORAGE_KEYS.eventSlug);
  }
}

export function setAdminKey(key) {
  state.adminKey = key || "";
  if (state.adminKey) {
    sessionStorage.setItem(STORAGE_KEYS.adminKey, state.adminKey);
  } else {
    sessionStorage.removeItem(STORAGE_KEYS.adminKey);
  }
}
