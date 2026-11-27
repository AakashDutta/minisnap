# MiniSnap — Studio Edition

A browser-based 4-frame photobooth web application built for **BGKV (Bhavan's Gangabux Kanoria Vidyamandir, Kolkata)**. Guests pick a camera lens and strip finish, capture four frames with a 5-second countdown, download the generated keepsake strip directly, or generate a 24-hour private QR code backed by Supabase.

## Features

- **Zero-build static frontend** (`index.html`): Single-file HTML/CSS/JS application using WebRTC (`getUserMedia`) and HTML5 Canvas.
- **8 computational photo lenses**:
  - `Studio Clean` — Natural clarity and subtle contrast
  - `Paris Glow` — Soft bloom and warm halo
  - `Golden Hour` — Amber warmth and sunlit lens flare
  - `Y2K Digicam` — High-contrast flash pop and film grain
  - `Rio Sunset` — Coral highlights and teal shadows
  - `Prism Dream` — Edge RGB split and rainbow light leak
  - `Velvet Noir` — High-contrast monochrome with grain
  - `Neon Signal` — Edge glow, scanlines, and AR HUD framing
- **3 strip finishes**: `Blush`, `Vanilla`, and `Midnight` borders rendered onto a 720px-wide 4-frame JPEG strip (`MiniSnap-Memory.jpg`).
- **Camera controls**: Front/rear camera toggle (`user` / `environment`), automatic selfie mirroring in preview and output, wide-angle `0.5x` zoom constraint when supported by the device, and post-capture `±90°` strip rotation.
- **Private QR delivery**: Optional cloud upload gated behind an 8-digit booth PIN, generating a QR code (`qrcodejs`) to a 24-hour guest link (`?guest=<token>`) with 10-minute signed download URLs and Web Share API support.
- **Operator Admin Desk**: Built-in admin view (`ADMIN ACCESS` in footer) to inspect the 100 most recent sessions, view guest open counts, and delete expired photos from storage and database.

## Project Structure

```text
.
├── index.html                        # Current Studio Edition photobooth frontend
├── index-legacy.html                 # Previous version of the photobooth UI
├── index (1).html                    # Redirect shim to ./?build=2026-11-24-livefix-1
└── supabase/
    ├── config.toml                   # Edge Function config (verify_jwt = false)
    ├── minisnap-booth-pin.sql        # Booth PIN IP rate-limiting table & RPC
    └── functions/
        └── minisnap/
            └── index.ts              # Supabase Edge Function API
```

## Architecture & Security Model

Photos stay on the booth device until the user clicks **Create QR Code**.

1. **Booth Authentication (`POST ?action=booth-auth`)**:
   - Validates the 8-digit `MINISNAP_BOOTH_PIN`.
   - Rate-limits attempts per hashed client IP (`5` attempts per `15 minutes`) via `public.minisnap_check_booth_attempt`.
   - Issues an HMAC-SHA256 signed `boothToken` valid for 12 hours (`x-minisnap-booth` header).
2. **Strip Upload (`POST ?action=create`)**:
   - Verifies the `boothToken` and accepts a base64 JPEG up to 5 MB.
   - Uploads the image to the private `photo-strips` Supabase Storage bucket.
   - Generates a random 256-bit hex guest token, stores its SHA-256 hash in `photo_sessions` with a 24-hour `expires_at`, and returns the raw token for the QR code.
3. **Guest Delivery (`GET ?action=guest&token=...`)**:
   - Hashes the token and checks expiration.
   - Generates 10-minute signed view and download URLs from `photo-strips` and increments `guest_access_count`.
4. **Admin Operations (`GET ?action=admin`, `POST ?action=delete-expired`)**:
   - Protected by the `x-minisnap-admin` header matching `MINISNAP_ADMIN_KEY`.
   - Lists the latest 100 sessions or deletes up to 500 expired strips and database rows per call.

## Setup & Deployment

### 1. Supabase Database & Storage

Create the following resources in your Supabase project (not included in the SQL file):

- **Storage bucket**: Private bucket named `photo-strips`.
- **Database table**: `public.photo_sessions` with columns:
  - `id` (`uuid`, primary key)
  - `token_hash` (`text`, indexed/unique)
  - `storage_path` (`text`)
  - `created_at` (`timestamptz`, default `now()`)
  - `expires_at` (`timestamptz`)
  - `last_accessed_at` (`timestamptz`, nullable)
  - `guest_access_count` (`integer`, default `0`)

Then run `supabase/minisnap-booth-pin.sql` in the Supabase SQL Editor to create the `public.minisnap_booth_pin_attempts` table and `public.minisnap_check_booth_attempt` rate-limiting function.

### 2. Edge Function & Secrets

Deploy the Edge Function named `minisnap` (with `verify_jwt = false` from `supabase/config.toml`) and configure the required secrets:

```bash
supabase secrets set \
  MINISNAP_ADMIN_KEY="<32+ character secret>" \
  MINISNAP_BOOTH_PIN="<8-digit PIN>" \
  MINISNAP_BOOTH_TOKEN_SECRET="<32+ character secret>"

supabase functions deploy minisnap
```

Supabase automatically injects `SUPABASE_URL` and `SUPABASE_SECRET_KEYS` / `SUPABASE_SERVICE_ROLE_KEY`.

### 3. Frontend Configuration & Local Run

Update `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` near line 1248 of `index.html` if pointing to your own Supabase project.

Because `navigator.mediaDevices.getUserMedia` requires a secure context (`https://` or `http://localhost`), serve the root directory with any static file server for local testing:

```bash
npx serve .
# or
python -m http.server 8080
```

Open `http://localhost:8080` in a modern browser and grant camera permissions. Deploy `index.html` to any static host (GitHub Pages, Cloudflare Pages, Netlify, Vercel) for production use.
