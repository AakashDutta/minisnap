// MiniSnap v2 Edge Function: binary signed uploads (strip + 4 frames), private guest delivery,
// configurable retention, privacy waiver metadata, and Control Room admin APIs.
// Deploy as function name "minisnap". Secrets:
// MINISNAP_ADMIN_KEY (32+ chars), MINISNAP_BOOTH_PIN (8 digits), MINISNAP_BOOTH_TOKEN_SECRET (32+ chars).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function makeDb(url: string, serviceKey: string) {
  return createClient<any>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type DbClient = ReturnType<typeof makeDb>;

function getCorsHeaders(req: Request): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-minisnap-admin, x-minisnap-booth, x-minisnap-event-pass",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  const rawAllowed = Deno.env.get("MINISNAP_ALLOWED_ORIGINS")?.trim() ?? "";
  if (!rawAllowed) {
    return {
      ...base,
      "Access-Control-Allow-Origin": "*",
    };
  }
  const allowedOrigins = rawAllowed
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) {
    return {
      ...base,
      "Access-Control-Allow-Origin": "*",
    };
  }
  const origin = req.headers.get("origin") ?? "";
  if (origin && allowedOrigins.includes(origin)) {
    return {
      ...base,
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
    };
  }
  return {
    ...base,
    "Vary": "Origin",
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string) {
  return UUID_RE.test(value);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function sha256(value: string) {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

async function constantTimeEqual(a: string, b: string) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let mismatch = 0;
  for (let i = 0; i < ha.length; i++) {
    mismatch |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  }
  return mismatch === 0;
}

async function signPayload(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return base64url(signature);
}

async function createSignedToken(data: Record<string, unknown>, secret: string) {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(data)));
  const signature = await signPayload(payload, secret);
  return `${payload}.${signature}`;
}

async function verifySignedToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
  if (!token || secret.length < 32) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = await signPayload(parts[0], secret);
  if (!(await constantTimeEqual(expected, parts[1]))) return null;
  try {
    const encoded = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (encoded.length % 4)) % 4);
    const payload = JSON.parse(atob(encoded + pad));
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function getClientIp(req: Request) {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return xff[xff.length - 1] ?? "unknown";
}

async function adminAuthorized(req: Request, adminKey: string) {
  const supplied = req.headers.get("x-minisnap-admin") ?? "";
  return adminKey.length >= 32 && supplied.length > 0 && (await constantTimeEqual(supplied, adminKey));
}

async function checkRateLimit(
  db: DbClient,
  bucket: string,
  ipHash: string,
  maxAttempts: number,
  windowSeconds: number,
): Promise<boolean> {
  const { data, error } = await db.rpc("minisnap_check_rate_limit", {
    p_bucket: bucket,
    p_ip_hash: ipHash,
    p_max_attempts: maxAttempts,
    p_window_seconds: windowSeconds,
  });
  if (!error && typeof data === "boolean") return data;

  // Fallback to legacy booth RPC only if new schema RPC returned an error
  if (error && bucket === "booth-pin") {
    const legacy = await db.rpc("minisnap_check_booth_attempt", { p_ip_hash: ipHash });
    if (!legacy.error && typeof legacy.data === "boolean") return legacy.data;
  }
  return false;
}

function generateShortCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let code = "MS-";
  for (const b of bytes) code += chars[b % chars.length];
  return code;
}

function sanitizeCaption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\r\n\t]+/g, " ").trim().slice(0, 60);
  return cleaned || null;
}

async function getActiveEvent(db: DbClient, slug?: string | null) {
  const cleanSlug = slug?.trim() ?? "";
  let query = db.from("events").select("*").eq("is_active", true);
  if (cleanSlug) {
    query = query.eq("slug", cleanSlug);
  } else {
    query = query.order("created_at", { ascending: true }).limit(1);
  }
  const { data } = await query.maybeSingle();
  if (data) return data;
  if (cleanSlug) return null;
  return {
    id: null,
    slug: "bgkv-studio",
    title: "MINISNAP PHOTOBOOTH",
    subtitle: "BGKV · STUDIO",
    footer_text: "A SCHOOL MEMORY · KOLKATA",
    retention_hours: 24,
    auto_upload: true,
    open_guest_access: false,
    waiver_version: "v1.0-all-inclusive",
    waiver_text:
      "By opting in, you allow event organizers to include your captured photos in an official commemorative event collage. Your private link remains unshared with other guests.",
  };
}

async function authorizeUpload(
  req: Request,
  db: DbClient,
  secret: string,
  event: Record<string, unknown>,
  ipHash: string,
): Promise<{ ok: true; mode: string } | { ok: false; error: string; status: number }> {
  const boothToken = req.headers.get("x-minisnap-booth") ?? "";
  if (boothToken) {
    const payload = await verifySignedToken(boothToken, secret);
    if (payload && payload.type === "booth") {
      const allowed = await checkRateLimit(db, "booth-upload", ipHash, 120, 900);
      if (!allowed) {
        return { ok: false, error: "Too many booth uploads. Wait a few minutes.", status: 429 };
      }
      return { ok: true, mode: "booth-pin" };
    }
    return { ok: false, error: "Booth session expired. Enter the booth PIN again.", status: 401 };
  }

  const eventPass = req.headers.get("x-minisnap-event-pass") ?? "";
  if (eventPass) {
    const payload = await verifySignedToken(eventPass, secret);
    if (payload && payload.type === "event_pass" && payload.slug === event.slug) {
      const allowed = await checkRateLimit(db, "pass-upload", ipHash, 60, 900);
      if (!allowed) {
        return { ok: false, error: "Too many uploads on this event pass. Wait a few minutes.", status: 429 };
      }
      return { ok: true, mode: "event-pass" };
    }
    if (!event.open_guest_access) {
      return {
        ok: false,
        error: "Event pass QR has expired or is invalid for this event.",
        status: 401,
      };
    }
  }

  if (event.open_guest_access) {
    const allowed = await checkRateLimit(db, "open-upload", ipHash, 15, 900);
    if (!allowed) {
      return { ok: false, error: "Too many uploads from this connection. Wait a few minutes.", status: 429 };
    }
    return { ok: true, mode: "open-guest" };
  }

  return {
    ok: false,
    error: "Booth PIN or venue Event Pass QR required to upload.",
    status: 401,
  };
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  let secretKeys: Record<string, string> = {};
  try {
    secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
  } catch {
    secretKeys = {};
  }
  const serviceKey = secretKeys?.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const adminKey = Deno.env.get("MINISNAP_ADMIN_KEY") ?? "";
  const boothPin = Deno.env.get("MINISNAP_BOOTH_PIN") ?? "";
  const boothTokenSecret = Deno.env.get("MINISNAP_BOOTH_TOKEN_SECRET") ?? "";

  if (!supabaseUrl || !serviceKey || adminKey.length < 32) {
    return json({ error: "Server is not configured. Check Edge Function secrets." }, 500);
  }

  const db = makeDb(supabaseUrl, serviceKey);

  const ipHash = await sha256(getClientIp(req));

  try {
    // 1. Public active event configuration
    if (action === "event-config" && req.method === "GET") {
      const slug = url.searchParams.get("slug");
      const event = await getActiveEvent(db, slug);
      if (!event) return json({ error: "Event not found or inactive." }, 404);
      return json({
        ok: true,
        event: {
          id: event.id,
          slug: event.slug,
          title: event.title,
          subtitle: event.subtitle,
          footerText: event.footer_text,
          retentionHours: event.retention_hours,
          autoUpload: event.auto_upload,
          openGuestAccess: event.open_guest_access,
          waiverVersion: event.waiver_version,
          waiverText: event.waiver_text,
        },
      });
    }

    // 2. Booth PIN Authentication (operator unlock -> 12h HMAC token)
    if (action === "booth-auth" && req.method === "POST") {
      if (!/^\d{8}$/.test(boothPin) || boothTokenSecret.length < 32) {
        return json({ error: "Booth PIN is not configured. Set the booth secrets in Supabase." }, 503);
      }
      const allowed = await checkRateLimit(db, "booth-pin", ipHash, 5, 900);
      if (!allowed) {
        return json({ error: "Too many PIN attempts. Wait 15 minutes and try again." }, 429);
      }
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const supplied = String(body.pin ?? "");
      if (!(await constantTimeEqual(supplied, boothPin))) {
        return json({ error: "Incorrect booth PIN." }, 401);
      }
      const boothToken = await createSignedToken(
        { type: "booth", exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60 },
        boothTokenSecret,
      );
      return json({ ok: true, boothToken, expiresIn: 43200 });
    }

    // 3. 2-Step Binary Upload: prepare signed Storage URLs for strip + 4 frames
    if (action === "prepare-upload" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const event = await getActiveEvent(db, typeof body.eventSlug === "string" ? body.eventSlug : null);
      if (!event) return json({ error: "Event not found or inactive." }, 404);
      const auth = await authorizeUpload(req, db, boothTokenSecret, event, ipHash);
      if (!auth.ok) return json({ error: auth.error }, auth.status);

      const frameCount = Math.min(4, Math.max(0, Number(body.frameCount ?? 4) | 0));
      const filterId = String(body.filterId ?? "none").slice(0, 24);
      const stripTheme = String(body.stripTheme ?? "pink").slice(0, 24);
      const layoutType = String(body.layoutType ?? "strip-4").slice(0, 24);
      const caption = sanitizeCaption(body.caption);
      const collageConsent = Boolean(body.collageConsent);
      const waiverVersion = collageConsent
        ? String(body.waiverVersion ?? event.waiver_version ?? "v1.0-all-inclusive").slice(0, 48)
        : null;

      const id = crypto.randomUUID();
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      const tokenHash = await sha256(token);
      const stripPath = `${id}/strip.jpg`;
      const framePaths: string[] = [];
      for (let i = 1; i <= frameCount; i++) {
        framePaths.push(`${id}/frames/0${i}.jpg`);
      }

      const retentionHours = Number(event.retention_hours ?? 24);
      const expiresAt = new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString();

      let shortCode = generateShortCode();
      let insertError: { code?: string; message?: string } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await db.from("photo_sessions").insert({
          id,
          short_code: shortCode,
          event_id: event.id ?? null,
          token_hash: tokenHash,
          storage_path: stripPath,
          frame_paths: framePaths,
          filter_id: filterId,
          strip_theme: stripTheme,
          layout_type: layoutType,
          caption,
          upload_status: "pending",
          collage_consent: collageConsent,
          collage_consent_at: collageConsent ? new Date().toISOString() : null,
          waiver_version: waiverVersion,
          expires_at: expiresAt,
        });
        insertError = res.error;
        if (!insertError || insertError.code !== "23505") break;
        shortCode = generateShortCode();
      }
      if (insertError) {
        console.error("prepare-upload insert error:", insertError);
        return json({ error: "Database operation failed." }, 500);
      }

      const stripSigned = await db.storage.from("photo-strips").createSignedUploadUrl(stripPath);
      if (stripSigned.error || !stripSigned.data) {
        await db.from("photo_sessions").delete().eq("id", id);
        console.error("prepare-upload strip signed url error:", stripSigned.error);
        return json({ error: "Storage operation failed." }, 500);
      }

      const frameUploads: Array<{ index: number; path: string; signedUrl: string; token: string }> = [];
      for (let i = 0; i < framePaths.length; i++) {
        const res = await db.storage.from("photo-strips").createSignedUploadUrl(framePaths[i]);
        if (res.error || !res.data) {
          await db.from("photo_sessions").delete().eq("id", id);
          console.error("prepare-upload frame signed url error:", res.error);
          return json({ error: "Storage operation failed." }, 500);
        }
        frameUploads.push({
          index: i + 1,
          path: framePaths[i],
          signedUrl: res.data.signedUrl,
          token: res.data.token,
        });
      }

      return json({
        ok: true,
        sessionId: id,
        shortCode,
        token,
        expiresAt,
        stripUpload: {
          path: stripPath,
          signedUrl: stripSigned.data.signedUrl,
          token: stripSigned.data.token,
        },
        frameUploads,
      });
    }

    // 4. Finalize binary upload (verifies files in Storage and marks session ready)
    if (action === "finalize-upload" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const token = String(body.token ?? "");
      if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: "Invalid session token." }, 400);
      const tokenHash = await sha256(token);

      const { data: session, error } = await db
        .from("photo_sessions")
        .select("id,short_code,storage_path,frame_paths,upload_status,expires_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (error) {
        console.error("finalize-upload query error:", error);
        return json({ error: "Database operation failed." }, 500);
      }
      if (!session) return json({ error: "Session not found." }, 404);
      if (session.upload_status !== "pending") {
        return json({ error: "Session upload has already been finalized." }, 409);
      }
      if (new Date(session.expires_at).getTime() <= Date.now()) {
        return json({ error: "Session has expired." }, 410);
      }

      const { data: stripObjs, error: stripListErr } = await db.storage
        .from("photo-strips")
        .list(session.id);
      if (stripListErr) {
        console.error("finalize-upload strip list error:", stripListErr);
        return json({ error: "Storage operation failed." }, 500);
      }
      const stripFile = (stripObjs ?? []).find((f) => f.name === "strip.jpg");
      if (!stripFile) return json({ error: "Strip file upload was incomplete." }, 400);

      let totalBytes = Number((stripFile.metadata as Record<string, unknown> | null)?.size ?? 0);
      const { data: frameObjs, error: frameListErr } = await db.storage
        .from("photo-strips")
        .list(`${session.id}/frames`);
      if (frameListErr) {
        console.error("finalize-upload frame list error:", frameListErr);
        return json({ error: "Storage operation failed." }, 500);
      }
      const expectedFramePaths = Array.isArray(session.frame_paths)
        ? (session.frame_paths as string[]).filter(Boolean)
        : [];
      if (expectedFramePaths.length > 0) {
        const uploadedNames = new Set((frameObjs ?? []).map((f) => f.name));
        for (const fp of expectedFramePaths) {
          const filename = fp.split("/").pop() ?? "";
          if (!filename || !uploadedNames.has(filename)) {
            return json({ error: "Frame file upload was incomplete." }, 400);
          }
        }
      }
      for (const f of frameObjs ?? []) {
        totalBytes += Number((f.metadata as Record<string, unknown> | null)?.size ?? 0);
      }
      if (!totalBytes && typeof body.declaredBytes === "number") {
        totalBytes = Math.max(0, Math.min(20 * 1024 * 1024, Math.round(body.declaredBytes)));
      }

      const { error: updateError } = await db
        .from("photo_sessions")
        .update({ upload_status: "ready", total_bytes: totalBytes })
        .eq("id", session.id);
      if (updateError) {
        console.error("finalize-upload update error:", updateError);
        return json({ error: "Database operation failed." }, 500);
      }

      return json({
        ok: true,
        sessionId: session.id,
        shortCode: session.short_code,
        expiresAt: session.expires_at,
        totalBytes,
      });
    }

    // 5. Legacy single-request base64 upload (kept for compatibility)
    if (action === "create" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const event = await getActiveEvent(db, typeof body.eventSlug === "string" ? body.eventSlug : null);
      if (!event) return json({ error: "Event not found or inactive." }, 404);
      const auth = await authorizeUpload(req, db, boothTokenSecret, event, ipHash);
      if (!auth.ok) return json({ error: auth.error }, auth.status);

      const dataUrl = String(body.image ?? "");
      const match = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return json({ error: "A JPEG image is required." }, 400);
      const binary = atob(match[1]);
      if (binary.length > 5 * 1024 * 1024) return json({ error: "Image exceeds 5 MB." }, 413);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      const tokenHash = await sha256(token);
      const id = crypto.randomUUID();
      const storagePath = `${id}/strip.jpg`;
      const { error: uploadError } = await db.storage
        .from("photo-strips")
        .upload(storagePath, bytes, { contentType: "image/jpeg", upsert: false });
      if (uploadError) {
        console.error("create storage upload error:", uploadError);
        return json({ error: "Storage operation failed." }, 500);
      }

      const retentionHours = Number(event.retention_hours ?? 24);
      const expiresAt = new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString();
      let shortCode = generateShortCode();
      let insertError: { code?: string; message?: string } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await db.from("photo_sessions").insert({
          id,
          short_code: shortCode,
          event_id: event.id ?? null,
          token_hash: tokenHash,
          storage_path: storagePath,
          total_bytes: bytes.length,
          upload_status: "ready",
          expires_at: expiresAt,
        });
        insertError = res.error;
        if (!insertError || insertError.code !== "23505") break;
        shortCode = generateShortCode();
      }
      if (insertError) {
        await db.storage.from("photo-strips").remove([storagePath]);
        console.error("create insert error:", insertError);
        return json({ error: "Database operation failed." }, 500);
      }
      return json({ ok: true, token, shortCode, expiresAt });
    }

    // 6. Strictly Private Guest Delivery (strip + individual frames)
    if (action === "guest" && (req.method === "GET" || req.method === "POST")) {
      let token = "";
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body) return json({ error: "Invalid JSON body." }, 400);
        token = String(body.token ?? "");
      } else {
        token = url.searchParams.get("token") ?? "";
      }
      if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: "Invalid or expired MiniSnap link." }, 404);
      const tokenHash = await sha256(token);

      const { data: session, error } = await db
        .from("photo_sessions")
        .select(
          "id,short_code,storage_path,frame_paths,filter_id,strip_theme,layout_type,caption,collage_consent,upload_status,created_at,expires_at,guest_access_count",
        )
        .eq("token_hash", tokenHash)
        .maybeSingle();

      if (
        error ||
        !session ||
        session.upload_status !== "ready" ||
        new Date(session.expires_at).getTime() <= Date.now()
      ) {
        return json({ error: "This MiniSnap link has expired or is unavailable." }, 404);
      }

      const { data: signed, error: signError } = await db.storage
        .from("photo-strips")
        .createSignedUrl(session.storage_path, 60 * 10);
      const { data: download, error: downloadError } = await db.storage
        .from("photo-strips")
        .createSignedUrl(session.storage_path, 60 * 10, {
          download: `MiniSnap-${session.short_code ?? "Memory"}.jpg`,
        });

      if (signError || downloadError || !signed?.signedUrl || !download?.signedUrl) {
        console.error("guest signed url error:", signError ?? downloadError);
        return json({ error: "Could not prepare your photo." }, 500);
      }

      const rawFramePaths = Array.isArray(session.frame_paths) ? (session.frame_paths as string[]) : [];
      const frames: Array<{ index: number; viewUrl: string; downloadUrl: string }> = [];
      for (let i = 0; i < rawFramePaths.length; i++) {
        const fp = rawFramePaths[i];
        const [fv, fd] = await Promise.all([
          db.storage.from("photo-strips").createSignedUrl(fp, 60 * 10),
          db.storage.from("photo-strips").createSignedUrl(fp, 60 * 10, {
            download: `MiniSnap-${session.short_code ?? "Frame"}-0${i + 1}.jpg`,
          }),
        ]);
        if (fv.data?.signedUrl && fd.data?.signedUrl) {
          frames.push({
            index: i + 1,
            viewUrl: fv.data.signedUrl,
            downloadUrl: fd.data.signedUrl,
          });
        }
      }

      await db.rpc("minisnap_record_guest_access", { p_session_id: session.id });

      return json({
        ok: true,
        shortCode: session.short_code,
        imageUrl: signed.signedUrl,
        downloadUrl: download.signedUrl,
        frames,
        filterId: session.filter_id,
        stripTheme: session.strip_theme,
        layoutType: session.layout_type,
        caption: session.caption,
        collageConsent: session.collage_consent,
        createdAt: session.created_at,
        expiresAt: session.expires_at,
      });
    }

    // 7. Guest instant self-delete (privacy control)
    if (action === "guest-delete" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const token = String(body.token ?? "");
      if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: "Invalid token." }, 400);
      const tokenHash = await sha256(token);
      const { data: session, error: findErr } = await db
        .from("photo_sessions")
        .select("id,storage_path,frame_paths")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (findErr) {
        console.error("guest-delete lookup error:", findErr);
        return json({ error: "Database operation failed." }, 500);
      }
      if (!session) return json({ ok: true, deleted: false });

      const paths = [
        session.storage_path,
        ...(Array.isArray(session.frame_paths) ? (session.frame_paths as string[]) : []),
      ].filter(Boolean);
      if (paths.length) {
        const { error: rmErr } = await db.storage.from("photo-strips").remove(paths);
        if (rmErr) {
          console.error("guest-delete storage remove error:", rmErr);
          return json({ error: "Storage operation failed." }, 500);
        }
      }
      const { error: delErr } = await db.from("photo_sessions").delete().eq("id", session.id);
      if (delErr) {
        console.error("guest-delete db delete error:", delErr);
        return json({ error: "Database operation failed." }, 500);
      }
      return json({ ok: true, deleted: true });
    }

    // --- ADMIN ROUTES (failed-attempt rate limit + constant-time key verification) ---
    if (action?.startsWith("admin") || action === "delete-expired") {
      const { data: limitRow, error: limitError } = await db
        .from("minisnap_rate_limits")
        .select("window_started_at,attempts")
        .eq("bucket", "admin-auth-fail")
        .eq("ip_hash", ipHash)
        .maybeSingle();
      if (limitError) {
        console.error("admin rate limit lookup error:", limitError);
        return json({ error: "Rate limit check unavailable." }, 503);
      }
      if (
        limitRow &&
        new Date(limitRow.window_started_at).getTime() >= Date.now() - 900_000 &&
        limitRow.attempts >= 10
      ) {
        return json({ error: "Too many failed admin attempts. Try again in 15 minutes." }, 429);
      }
      if (!(await adminAuthorized(req, adminKey))) {
        await checkRateLimit(db, "admin-auth-fail", ipHash, 10, 900);
        return json({ error: "Admin authorization failed." }, 401);
      }
    }

    if (action === "admin" && req.method === "GET") {
      const filter = url.searchParams.get("filter") ?? "all";
      const q = (url.searchParams.get("q") ?? "").trim();
      const rawLimit = Number(url.searchParams.get("limit") ?? 48);
      const rawOffset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(10, Math.trunc(rawLimit))) : 48;
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
      const nowIso = new Date().toISOString();

      const event = await getActiveEvent(db);

      // Summary stats (across recent/all sessions)
      const { data: allStatsRows, error: statsError } = await db
        .from("photo_sessions")
        .select("id,expires_at,is_archived,collage_consent,total_bytes,guest_access_count,upload_status")
        .eq("upload_status", "ready");
      if (statsError) {
        console.error("admin stats query error:", statsError);
        return json({ error: "Database operation failed." }, 500);
      }

      const nowMs = Date.now();
      const stats = {
        totalSessions: 0,
        activeSessions: 0,
        expiredSessions: 0,
        archivedCount: 0,
        collageApproved: 0,
        expiringSoon: 0,
        totalBytes: 0,
        totalGuestOpens: 0,
      };
      for (const r of allStatsRows ?? []) {
        stats.totalSessions += 1;
        stats.totalBytes += Number(r.total_bytes ?? 0);
        stats.totalGuestOpens += Number(r.guest_access_count ?? 0);
        if (r.is_archived) stats.archivedCount += 1;
        if (r.collage_consent) stats.collageApproved += 1;
        const expMs = new Date(r.expires_at).getTime();
        if (r.is_archived || expMs > nowMs) {
          stats.activeSessions += 1;
          if (!r.is_archived && expMs - nowMs <= 2 * 60 * 60 * 1000) {
            stats.expiringSoon += 1;
          }
        } else {
          stats.expiredSessions += 1;
        }
      }

      let query = db
        .from("photo_sessions")
        .select(
          "id,short_code,storage_path,frame_paths,filter_id,strip_theme,layout_type,caption,total_bytes,upload_status,collage_consent,collage_consent_at,is_archived,created_at,expires_at,last_accessed_at,guest_access_count",
        )
        .eq("upload_status", "ready")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (filter === "active") {
        query = query.or(`is_archived.eq.true,expires_at.gt.${nowIso}`);
      } else if (filter === "expired") {
        query = query.eq("is_archived", false).lte("expires_at", nowIso);
      } else if (filter === "archived") {
        query = query.eq("is_archived", true);
      } else if (filter === "collage") {
        query = query.eq("collage_consent", true);
      }

      if (q) {
        const cleanQ = q.replace(/[%_,().\\]/g, "");
        if (cleanQ) {
          query = query.or(`short_code.ilike.%${cleanQ}%,caption.ilike.%${cleanQ}%`);
        }
      }

      const { data: rows, error } = await query;
      if (error) {
        console.error("admin query error:", error);
        return json({ error: "Database operation failed." }, 500);
      }

      const sessions = await Promise.all(
        (rows ?? []).map(async (s) => {
          const { data: thumb } = await db.storage
            .from("photo-strips")
            .createSignedUrl(s.storage_path, 60 * 15);
          return {
            ...s,
            thumbUrl: thumb?.signedUrl ?? null,
            frameCount: Array.isArray(s.frame_paths) ? s.frame_paths.length : 0,
          };
        }),
      );

      return json({
        ok: true,
        event: {
          id: event.id,
          slug: event.slug,
          title: event.title,
          subtitle: event.subtitle,
          footerText: event.footer_text,
          retentionHours: event.retention_hours,
          autoUpload: event.auto_upload,
          openGuestAccess: event.open_guest_access,
          waiverVersion: event.waiver_version,
          waiverText: event.waiver_text,
        },
        stats,
        sessions,
        limit,
        offset,
        hasMore: (rows?.length ?? 0) === limit,
      });
    }

    if (action === "admin-session" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      if (!isUuid(id)) return json({ error: "Invalid session ID." }, 400);
      const { data: s, error } = await db
        .from("photo_sessions")
        .select(
          "id,short_code,event_id,storage_path,frame_paths,filter_id,strip_theme,layout_type,caption,total_bytes,upload_status,collage_consent,collage_consent_at,waiver_version,is_archived,created_at,expires_at,last_accessed_at,guest_access_count",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) {
        console.error("admin-session query error:", error);
        return json({ error: "Database operation failed." }, 500);
      }
      if (!s) return json({ error: "Session not found." }, 404);

      const { data: stripSigned } = await db.storage
        .from("photo-strips")
        .createSignedUrl(s.storage_path, 60 * 15);
      const { data: stripDownload } = await db.storage
        .from("photo-strips")
        .createSignedUrl(s.storage_path, 60 * 15, {
          download: `MiniSnap-${s.short_code ?? "Strip"}.jpg`,
        });

      const framePaths = Array.isArray(s.frame_paths) ? (s.frame_paths as string[]) : [];
      const frames: Array<{ index: number; viewUrl: string; downloadUrl: string }> = [];
      for (let i = 0; i < framePaths.length; i++) {
        const [fv, fd] = await Promise.all([
          db.storage.from("photo-strips").createSignedUrl(framePaths[i], 60 * 15),
          db.storage.from("photo-strips").createSignedUrl(framePaths[i], 60 * 15, {
            download: `MiniSnap-${s.short_code ?? "Frame"}-0${i + 1}.jpg`,
          }),
        ]);
        if (fv.data?.signedUrl && fd.data?.signedUrl) {
          frames.push({ index: i + 1, viewUrl: fv.data.signedUrl, downloadUrl: fd.data.signedUrl });
        }
      }

      return json({
        ok: true,
        session: {
          ...s,
          stripUrl: stripSigned?.signedUrl ?? null,
          stripDownloadUrl: stripDownload?.signedUrl ?? null,
          frames,
        },
      });
    }

    if (action === "admin-update" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const id = String(body.id ?? "");
      if (!isUuid(id)) return json({ error: "Invalid session ID." }, 400);
      const { data: existing, error: findError } = await db
        .from("photo_sessions")
        .select("id,expires_at,is_archived,collage_consent")
        .eq("id", id)
        .maybeSingle();
      if (findError) {
        console.error("admin-update lookup error:", findError);
        return json({ error: "Database operation failed." }, 500);
      }
      if (!existing) return json({ error: "Session not found." }, 404);

      const patch: Record<string, unknown> = {};
      if (typeof body.isArchived === "boolean") patch.is_archived = body.isArchived;
      if (typeof body.collageConsent === "boolean") patch.collage_consent = body.collageConsent;
      if (
        typeof body.extendHours === "number" &&
        Number.isFinite(body.extendHours) &&
        body.extendHours > 0 &&
        body.extendHours <= 8760
      ) {
        const base = Math.max(Date.now(), new Date(existing.expires_at).getTime());
        patch.expires_at = new Date(base + body.extendHours * 3600 * 1000).toISOString();
      }
      if (Object.keys(patch).length === 0) {
        return json({ error: "No valid fields to update." }, 400);
      }
      const { error: updError } = await db.from("photo_sessions").update(patch).eq("id", id);
      if (updError) {
        console.error("admin-update error:", updError);
        return json({ error: "Database operation failed." }, 500);
      }
      return json({ ok: true });
    }

    if (action === "admin-reissue" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const id = String(body.id ?? "");
      if (!isUuid(id)) return json({ error: "Invalid session ID." }, 400);
      const { data: existing, error: findError } = await db
        .from("photo_sessions")
        .select("id,short_code,expires_at")
        .eq("id", id)
        .maybeSingle();
      if (findError) {
        console.error("admin-reissue lookup error:", findError);
        return json({ error: "Database operation failed." }, 500);
      }
      if (!existing) return json({ error: "Session not found." }, 404);

      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      const tokenHash = await sha256(token);
      const nextExpiry = Math.max(Date.now() + 24 * 3600 * 1000, new Date(existing.expires_at).getTime());
      const expiresAt = new Date(nextExpiry).toISOString();

      const { error: updError } = await db
        .from("photo_sessions")
        .update({ token_hash: tokenHash, expires_at: expiresAt })
        .eq("id", id);
      if (updError) {
        console.error("admin-reissue error:", updError);
        return json({ error: "Database operation failed." }, 500);
      }
      return json({ ok: true, token, shortCode: existing.short_code, expiresAt });
    }

    if (action === "admin-delete" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const id = String(body.id ?? "");
      if (!isUuid(id)) return json({ error: "Invalid session ID." }, 400);
      const { data: existing, error: findError } = await db
        .from("photo_sessions")
        .select("id,storage_path,frame_paths")
        .eq("id", id)
        .maybeSingle();
      if (findError) {
        console.error("admin-delete lookup error:", findError);
        return json({ error: "Database operation failed." }, 500);
      }
      if (!existing) return json({ error: "Session not found." }, 404);

      const paths = [
        existing.storage_path,
        ...(Array.isArray(existing.frame_paths) ? (existing.frame_paths as string[]) : []),
      ].filter(Boolean);
      if (paths.length) {
        const { error: rmErr } = await db.storage.from("photo-strips").remove(paths);
        if (rmErr) {
          console.error("admin-delete storage remove error:", rmErr);
          return json({ error: "Storage operation failed." }, 500);
        }
      }
      const { error: delErr } = await db.from("photo_sessions").delete().eq("id", id);
      if (delErr) {
        console.error("admin-delete db delete error:", delErr);
        return json({ error: "Database operation failed." }, 500);
      }
      return json({ ok: true, deleted: id });
    }

    if (action === "admin-event" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const active = await getActiveEvent(db);
      const retentionHours = Math.min(8760, Math.max(1, Number(body.retentionHours ?? 24) | 0));
      const payload = {
        title: String(body.title ?? active.title).trim().slice(0, 60) || "MINISNAP PHOTOBOOTH",
        subtitle: String(body.subtitle ?? active.subtitle).trim().slice(0, 60) || "BGKV · STUDIO",
        footer_text: String(body.footerText ?? active.footer_text).trim().slice(0, 80) || "A SCHOOL MEMORY",
        retention_hours: retentionHours,
        auto_upload: Boolean(body.autoUpload ?? true),
        open_guest_access: Boolean(body.openGuestAccess ?? true),
        waiver_version: String(body.waiverVersion ?? active.waiver_version).trim().slice(0, 48),
        waiver_text: String(body.waiverText ?? active.waiver_text).trim().slice(0, 2000),
        updated_at: new Date().toISOString(),
      };
      if (active.id) {
        const { error } = await db.from("events").update(payload).eq("id", active.id);
        if (error) {
          console.error("admin-event update error:", error);
          return json({ error: "Database operation failed." }, 500);
        }
      } else {
        const { error } = await db.from("events").insert({ slug: "bgkv-studio", is_active: true, ...payload });
        if (error) {
          console.error("admin-event insert error:", error);
          return json({ error: "Database operation failed." }, 500);
        }
      }
      return json({ ok: true });
    }

    if (action === "admin-event-pass" && req.method === "POST") {
      if (boothTokenSecret.length < 32) {
        return json({ error: "MINISNAP_BOOTH_TOKEN_SECRET must be at least 32 characters." }, 503);
      }
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const hours = Math.min(168, Math.max(1, Number(body.hours ?? 24) | 0));
      const active = await getActiveEvent(db);
      const passToken = await createSignedToken(
        {
          type: "event_pass",
          slug: active.slug,
          exp: Math.floor(Date.now() / 1000) + hours * 3600,
        },
        boothTokenSecret,
      );
      return json({ ok: true, slug: active.slug, passToken, expiresInHours: hours });
    }

    if (action === "delete-expired" && req.method === "POST") {
      const now = new Date().toISOString();
      const stalePendingCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      const { data: expired, error } = await db
        .from("photo_sessions")
        .select("id,storage_path,frame_paths")
        .or(`and(is_archived.eq.false,expires_at.lte.${now}),and(upload_status.eq.pending,created_at.lte.${stalePendingCutoff})`)
        .limit(250);
      if (error) {
        console.error("delete-expired query error:", error);
        return json({ error: "Database operation failed." }, 500);
      }
      if (!expired?.length) return json({ ok: true, deleted: 0 });

      const paths: string[] = [];
      for (const s of expired) {
        if (s.storage_path) paths.push(s.storage_path);
        if (Array.isArray(s.frame_paths)) {
          for (const fp of s.frame_paths as string[]) {
            if (fp) paths.push(fp);
          }
        }
      }
      if (paths.length) {
        const { error: removeError } = await db.storage.from("photo-strips").remove(paths);
        if (removeError) {
          console.error("delete-expired storage remove error:", removeError);
          return json({ error: "Storage operation failed." }, 500);
        }
      }
      const ids = expired.map((s) => s.id);
      const { error: deleteError } = await db.from("photo_sessions").delete().in("id", ids);
      if (deleteError) {
        console.error("delete-expired db delete error:", deleteError);
        return json({ error: "Database operation failed." }, 500);
      }
      return json({ ok: true, deleted: ids.length, filesRemoved: paths.length });
    }

    return json({ error: "Unknown action." }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Unexpected server error." }, 500);
  }
});
