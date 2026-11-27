# MiniSnap — Studio Edition (v2)

A mobile-first browser photobooth web application built for **BGKV (Bhavan's Gangabux Kanoria Vidyamandir, Kolkata)**. Guests shoot 4 frames on their personal phones, auto-upload both the compiled keepsake strip and all 4 individual originals to a private Supabase Storage bucket, and receive a configurable ephemeral QR link (`?guest=<token>`) with an optional All-Inclusive Event Collage Privacy Waiver.

## Architecture Overview

- **Zero-build ES Modules Frontend**:
  - [index.html](index.html) — Multi-screen booth, motion-graphics homepage, guest delivery page, and Admin Control Room
  - [css/tokens.css](css/tokens.css), [css/studio.css](css/studio.css), [css/admin.css](css/admin.css) — Design tokens, GPU-only motion choreography, and responsive mobile/desktop layouts
  - [js/filters.js](js/filters.js) — 256-entry LUT photo grading engine across 8 lenses (`Studio Clean`, `Paris Glow`, `Golden Hour`, `Y2K Digicam`, `Rio Sunset`, `Prism Dream`, `Velvet Noir`, `Neon Signal`)
  - [js/camera.js](js/camera.js) — WebRTC viewfinder, wake lock, synthesized Web Audio cues, single-frame retake, and tab-resume recovery
  - [js/strip-renderer.js](js/strip-renderer.js) — Renders `1×4 Strip`, `2×2 Postcard`, and `1×3 Wide` layouts in `Blush`, `Vanilla`, or `Midnight`
  - [js/offline-queue.js](js/offline-queue.js) — IndexedDB queue for automatic background sync when venue Wi-Fi drops
  - [js/admin.js](js/admin.js) — Control Room with session ledger, 4-frame inspector, event/retention settings, venue Event Pass QR generator, and privacy-compliant Collage Vault poster builder
- **Supabase Backend**:
  - [supabase/migrations/001_minisnap_schema.sql](supabase/migrations/001_minisnap_schema.sql) — `events`, `photo_sessions`, strict RLS, rate-limit RPCs, atomic guest counter RPC, and private `photo-strips` bucket
  - [supabase/functions/minisnap/index.ts](supabase/functions/minisnap/index.ts) — Edge Function handling direct binary signed upload URLs, private guest delivery, guest self-delete, and Admin Control Room APIs

## Setup & Deployment

### 1. Database & Storage
Run [supabase/migrations/001_minisnap_schema.sql](supabase/migrations/001_minisnap_schema.sql) in the Supabase SQL Editor (or via `supabase db push`).

### 2. Edge Function & Secrets
Deploy the `minisnap` Edge Function (`verify_jwt = false` in `supabase/config.toml`) and configure secrets:

```bash
supabase secrets set \
  MINISNAP_ADMIN_KEY="<32+ character secret>" \
  MINISNAP_BOOTH_PIN="<8-digit PIN>" \
  MINISNAP_BOOTH_TOKEN_SECRET="<32+ character secret>"

supabase functions deploy minisnap
```

### 3. Local Run & Automated Tests

```bash
# Run unit tests (Node 20+)
node --test tests/*.test.mjs

# Serve locally for WebRTC camera access
npx serve .
# or
python -m http.server 8080
```
