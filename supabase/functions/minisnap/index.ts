// MiniSnap Edge Function: secure uploads, guest access and admin session list.
// Deploy as function name "minisnap". Set secrets:
// MINISNAP_ADMIN_KEY. Supabase injects SUPABASE_URL and SUPABASE_SECRET_KEYS.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-minisnap-admin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function adminOk(req: Request) {
  const expected = Deno.env.get("MINISNAP_ADMIN_KEY") ?? "";
  const supplied = req.headers.get("x-minisnap-admin") ?? "";
  return expected.length >= 32 && supplied.length === expected.length && supplied === expected;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
  const serviceKey = secretKeys.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const adminKey = Deno.env.get("MINISNAP_ADMIN_KEY") ?? "";
  if (!supabaseUrl || !serviceKey || adminKey.length < 32) {
    return json({ error: "Server is not configured. Check Edge Function secrets." }, 500);
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (action === "create" && req.method === "POST") {
      if (!adminOk(req)) return json({ error: "Admin authorization failed." }, 401);
      const body = await req.json();
      const dataUrl = String(body.image ?? "");
      const match = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return json({ error: "A JPEG image is required." }, 400);
      const binary = atob(match[1]);
      if (binary.length > 5 * 1024 * 1024) return json({ error: "Image exceeds 5 MB." }, 413);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const token = hex(tokenBytes);
      const tokenHash = await sha256(token);
      const id = crypto.randomUUID();
      const storagePath = `${id}.jpg`;
      const { error: uploadError } = await db.storage.from("photo-strips").upload(storagePath, bytes, {
        contentType: "image/jpeg",
        upsert: false,
      });
      if (uploadError) return json({ error: uploadError.message }, 500);

      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { error: insertError } = await db.from("photo_sessions").insert({
        id, token_hash: tokenHash, storage_path: storagePath, expires_at: expiresAt,
      });
      if (insertError) {
        await db.storage.from("photo-strips").remove([storagePath]);
        return json({ error: insertError.message }, 500);
      }
      return json({ ok: true, token, expiresAt });
    }

    if (action === "guest" && req.method === "GET") {
      const token = url.searchParams.get("token") ?? "";
      if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: "Invalid or expired MiniSnap link." }, 404);
      const tokenHash = await sha256(token);
      const { data: session, error } = await db.from("photo_sessions")
        .select("id,storage_path,expires_at,guest_access_count")
        .eq("token_hash", tokenHash).maybeSingle();
      if (error || !session || new Date(session.expires_at).getTime() <= Date.now()) {
        return json({ error: "This MiniSnap link has expired or is unavailable." }, 404);
      }
      const { data: signed, error: signError } = await db.storage.from("photo-strips")
        .createSignedUrl(session.storage_path, 60 * 10);
      const { data: download, error: downloadError } = await db.storage.from("photo-strips")
        .createSignedUrl(session.storage_path, 60 * 10, { download: "MiniSnap-Memory.jpg" });
      if (signError || downloadError || !signed?.signedUrl || !download?.signedUrl) {
        return json({ error: "Could not prepare your photo." }, 500);
      }
      await db.from("photo_sessions").update({
        last_accessed_at: new Date().toISOString(),
        guest_access_count: (session.guest_access_count ?? 0) + 1,
      }).eq("id", session.id);
      return json({ ok: true, imageUrl: signed.signedUrl, downloadUrl: download.signedUrl, expiresAt: session.expires_at });
    }

    if (action === "admin" && req.method === "GET") {
      if (!adminOk(req)) return json({ error: "Admin authorization failed." }, 401);
      const { data, error } = await db.from("photo_sessions")
        .select("id,created_at,expires_at,last_accessed_at,guest_access_count")
        .order("created_at", { ascending: false }).limit(100);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, sessions: data ?? [] });
    }

    if (action === "delete-expired" && req.method === "POST") {
      if (!adminOk(req)) return json({ error: "Admin authorization failed." }, 401);
      const now = new Date().toISOString();
      const { data: expired, error } = await db.from("photo_sessions")
        .select("id,storage_path").lte("expires_at", now).limit(500);
      if (error) return json({ error: error.message }, 500);
      if (!expired?.length) return json({ ok: true, deleted: 0 });
      const paths = expired.map((s) => s.storage_path);
      const { error: removeError } = await db.storage.from("photo-strips").remove(paths);
      if (removeError) return json({ error: removeError.message }, 500);
      const ids = expired.map((s) => s.id);
      const { error: deleteError } = await db.from("photo_sessions").delete().in("id", ids);
      if (deleteError) return json({ error: deleteError.message }, 500);
      return json({ ok: true, deleted: ids.length });
    }

    return json({ error: "Unknown action." }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Unexpected server error." }, 500);
  }
});
