import assert from "node:assert/strict";
import test from "node:test";

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signPayload(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return base64url(sig);
}

async function verifyToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = await signPayload(parts[0], secret);
  if (!constantTimeEqual(expected, parts[1])) return null;
  const encoded = parts[0].replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (encoded.length % 4)) % 4);
  const data = JSON.parse(atob(encoded + pad));
  return data.exp > Math.floor(Date.now() / 1000) ? data : null;
}

test("constantTimeEqual verifies exact matches only", () => {
  assert.equal(constantTimeEqual("secret-123", "secret-123"), true);
  assert.equal(constantTimeEqual("secret-123", "secret-124"), false);
  assert.equal(constantTimeEqual("short", "longer"), false);
});

test("HMAC signed eventPass token verifies valid tokens and rejects tampered or expired ones", async () => {
  const secret = "super-secret-signing-key-with-at-least-32-chars";
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({ type: "event_pass", slug: "bgkv-studio", exp: Math.floor(Date.now() / 1000) + 3600 }),
    ),
  );
  const sig = await signPayload(payload, secret);
  const valid = await verifyToken(`${payload}.${sig}`, secret);
  assert.equal(valid?.type, "event_pass");
  assert.equal(valid?.slug, "bgkv-studio");

  const tampered = await verifyToken(`${payload}.tamperedSig000`, secret);
  assert.equal(tampered, null);

  const expiredPayload = base64url(
    new TextEncoder().encode(JSON.stringify({ type: "event_pass", exp: 1000 })),
  );
  const expiredSig = await signPayload(expiredPayload, secret);
  assert.equal(await verifyToken(`${expiredPayload}.${expiredSig}`, secret), null);
});
