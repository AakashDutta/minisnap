import { EDGE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { state } from "./state.js";

async function withRequestTimeout(timeoutMs, timeoutMessage, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function edgeRequest(
  action,
  { method = "GET", body = null, query = {}, adminKey = "", boothToken = "", eventPass = "", timeoutMs = 45000 } = {},
) {
  const url = new URL(EDGE_URL);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const headers = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    "Content-Type": "application/json",
  };
  if (adminKey) headers["x-minisnap-admin"] = adminKey;
  if (boothToken) headers["x-minisnap-booth"] = boothToken;
  if (eventPass) headers["x-minisnap-event-pass"] = eventPass;

  return withRequestTimeout(
    timeoutMs,
    "Upload timed out. Saved in your offline queue for automatic retry.",
    async (signal) => {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      const data = await res.json().catch(() => ({ error: "Unreadable server response." }));
      if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return data;
    },
  );
}

export async function uploadBlobToSignedUrl(signedUrl, blob, timeoutMs = 45000) {
  return withRequestTimeout(
    timeoutMs,
    "Upload timed out. Saved in your offline queue for automatic retry.",
    async (signal) => {
      const res = await fetch(signedUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "image/jpeg",
          "x-upsert": "false",
        },
        body: blob,
        signal,
      });
      if (!res.ok) {
        throw new Error(`Storage upload failed (${res.status}).`);
      }
    },
  );
}

export async function uploadSessionBundle({ stripBlob, frameBlobs, metadata, onProgress }) {
  onProgress?.("Preparing private session…");
  const prep = await edgeRequest("prepare-upload", {
    method: "POST",
    boothToken: state.boothToken,
    eventPass: state.eventPass,
    body: {
      eventSlug: state.eventSlug || state.event.slug,
      frameCount: frameBlobs.length,
      filterId: metadata.filterId,
      stripTheme: metadata.stripTheme,
      layoutType: metadata.layoutType,
      caption: metadata.caption,
      collageConsent: metadata.collageConsent,
      waiverVersion: metadata.waiverVersion,
    },
  });

  const totalFiles = 1 + prep.frameUploads.length;
  let uploadedCount = 0;
  let declaredBytes = stripBlob.size;

  onProgress?.(`Uploading strip (1/${totalFiles})…`);
  await uploadBlobToSignedUrl(prep.stripUpload.signedUrl, stripBlob);
  uploadedCount += 1;

  await Promise.all(
    prep.frameUploads.map(async (f, idx) => {
      const blob = frameBlobs[idx];
      if (!blob) return;
      declaredBytes += blob.size;
      await uploadBlobToSignedUrl(f.signedUrl, blob);
      uploadedCount += 1;
      onProgress?.(`Syncing frames (${uploadedCount}/${totalFiles})…`);
    }),
  );

  onProgress?.("Finalizing private delivery…");
  const finalized = await edgeRequest("finalize-upload", {
    method: "POST",
    body: {
      token: prep.token,
      declaredBytes,
    },
  });

  return {
    sessionId: prep.sessionId,
    shortCode: finalized.shortCode || prep.shortCode,
    token: prep.token,
    expiresAt: finalized.expiresAt || prep.expiresAt,
  };
}
