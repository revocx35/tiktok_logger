# DEVLOG — construction notes

Short record of the decisions and the verification behind them. Keep it terse; it is for the next session, not for
users.

## 2026-10-22 — initial build (v1.0.0)

Built as the TikTok sibling of insta_logger, on the same core (auth, crypto, DB, gateway/worker, containers, web UI).

**What was reused unchanged** — the whole security/architecture spine: scrypt+HKDF passwords, TOTP, recovery keys,
envelope encryption (X25519 → DEK → AES-GCM fields/media), sessions and CSRF, the gateway/tenant/supervisor split, the
chromium manager with per-instance tokens, Caddy files, the compose stacks, the media queue and the web UI shell.

**What was replaced** — the Instagram protocol layer (`ig/`, `igweb/`, stories, reels) is gone; `tt/` is new:
`frames.ts` (schema-less protobuf walk + JSON recovery), `mapper.ts` (tolerant field matching), `dom.ts` (in-page agent
with selector candidates + heuristics), `watcher.ts` (CDP capture of IM sockets/answers), `service.ts` (state machine,
poll/re-check/refresh loops), `sender.ts` (composer automation), `ingest.ts` (content-key merging, album parts,
"missing" detection), `cookies.ts`/`loginwatch.ts` (TikTok cookies, no debugger while logged out).

**Why not sign requests**: TikTok signs with `X-Bogus`/`msToken`/`X-Gnarly` from its own bundle. The page does all
signing; the app only observes and drives. Documented in ARCHITECTURE §2.

**Decisions worth remembering**
* Capture is DOM-first, network-enriched. A message's row id is synthetic (`srv:<hash>`) until the network names it; then
  the row keeps its id and `alt_id` gets the server id. Merging uses `dedupe_key` (chat, sender, minute, type, text,
  media URL) plus a "single synthetic twin within 5 minutes" fallback.
* Own-message detection is geometric (right edge + alignment), not "position > half": wide photos broke the naive rule.
* Anti-delete judges only messages *strictly inside* the re-read range; the oldest visible row is the render boundary.
  A mid-conversation unsend is caught; a deletion of the very first message waits for a read that starts further back.
* Opening a conversation marks it read on TikTok — inherent, so the re-check interval is a setting and the README says
  it plainly.
* Unsend/edit/react automation is deliberately absent (localized menus, no edit on TikTok); the API answers
  `not_supported` and the UI hides those actions.
* Diagnostics (`/api/tt/diagnostics`, `/api/tt/probe`) + `TT_DOM_SELECTORS` exist because the DOM *will* change.

**Verification (all green on this host)**
* `server`: 124 vitest tests (includes new `tt/frames`, `tt/mapper`, `tt/ingest` suites).
* `web`: typecheck + 10 tests + production build (no inline scripts).
* `chromium/manager`: `go test ./...` with the re-derived token vectors (`ttl/chromium/...`).
* `scripts/dev/dom-check.mts`: 40 checks, twice (20 per mode) (with and without `data-e2e` attributes), against
  `fake-tiktok.mts` in a real headless Chromium (Mesa-less, broken CDN links on purpose).
* `scripts/dev/service-check.mts`: 12 checks — the real `TtService` against the fake with a real encrypted DB: ready
  state, 3 conversations imported, decrypted bodies, media queued, sending confirmed, a protobuf frame ingested, an
  unsent message flagged, and no duplicate rows from the two capture paths.
* Not run here (no Docker on this host): `scripts/smoke.sh` (containers, real tiktok.com login page) and the live
  TikTok check — both belong to the deployment step and to the owner's first login.

**Known gaps**
* Real TikTok Web is unverified (DOM selectors, IM answer shapes, frame format, login flow). `docs/tiktok-notes.md`
  lists the first-live-check procedure.
* `AGENTS.md` could not be written in this session (the write was blocked by the agent-instruction file guard); the
  conventions live in `ARCHITECTURE.md` and `scripts/dev/README.md` until it is added.
* No Android client (insta_logger has one); the API is ready for one.
