# Security policy

tiktok_logger stores private conversations, so its defaults are strict on purpose. This file says what is protected,
what is not, and how to report a problem.

## Reporting a vulnerability

Open a **private** security advisory on GitHub (`Security → Report a vulnerability`) — please do not open a public
issue. Include the version (tag), what you found and how to reproduce it. You will get an answer as soon as possible; a
fix is released as a patch version and (when relevant) the advisory is published afterwards.

## What the design protects against

* **Internet attackers at the login page**: no default credentials, single-owner signup closed behind `SETUP_TOKEN`,
  scrypt (N=2^17) password hashes, optional TOTP, per-IP *and* per-account brute-force locks charged before hashing,
  generic errors.
* **Stolen disk or backup**: message text, names, reaction emoji and all media are AES-256-GCM encrypted with data keys
  wrapped to the user's X25519 public key; the private key is only unwrappable with the password (or the recovery key)
  and a session cookie. A database dump alone decrypts nothing.
* **Another user (and the admin)**: a tenant is a unix user with its own database, keys, media and browser. The gateway
  holds a user list, never content. Workers listen on unix sockets behind a per-worker token; the tenant cookie is a
  routing hint only; a session is pinned to its user's port. The admin can reset or delete an account (denial of
  service) but cannot read its data.
* **Malicious content**: message text is rendered as text (never HTML), media is served with an inline-safe MIME
  allowlist and `Content-Security-Policy: sandbox` for everything else, no link previews are fetched, all API input is
  validated with zod, strict CSP with no inline scripts or styles.
* **A hostile page in the browser tab**: frames and API answers are untrusted input — bounded sizes, non-throwing
  decoders, ids validated by pattern, media fetched only from TikTok CDN hosts over HTTPS, signed CDN links kept in
  memory only.
* **CSRF/XSS against the owner's browser**: `SameSite=Strict` session cookie, an Origin check and an HMAC CSRF token on
  every state-changing request, decided from the matched route.
* **Lateral movement**: only caddy publishes ports; the app container has no internet; the chromium manager token-checks
  every request; every container runs with `cap_drop: ALL`, `no-new-privileges`, a read-only root filesystem and a
  memory/pid limit; Chromium keeps its sandbox.

## What it does not protect against

* **A compromised host** (root, hypervisor, a full container escape): it can read process memory, the live TikTok
  session and anything decrypted for a request.
* **A lost password *and* recovery key**: the data is unrecoverable by design. There is no backdoor.
* **TikTok itself**: the account's own history, the requests TikTok's client sends, and any restriction TikTok applies
  to the account.
* **Someone with the browser profile volume** (`chromium_profile`): it contains live TikTok logins. Back it up like a
  credential.
* **Metadata**: ids, timestamps, message types, flags, media sizes and the dedupe key are stored in plaintext (documented
  in `ARCHITECTURE.md` §6). Use full-disk encryption if that matters to you.

## Operational advice

* Run the stack behind HTTPS (the bundled Caddy with ACME, or your own proxy in HTTP mode with `COOKIE_SECURE=auto`).
* Keep `.env` (mode 600) and the volumes private; do not expose the app's port directly to the internet.
* Enable TOTP in Settings once you are set up, and store the recovery key offline.
* Update with `docker compose pull && docker compose up -d`; patch releases contain security fixes.
* Use a TikTok account you can afford to lose: automated browsers can be restricted by TikTok, whatever this project
  does. Recording conversations may require the other person's consent where you live.

## Supported versions

The latest tag on `main` gets fixes. Older tags are not patched — upgrade.
