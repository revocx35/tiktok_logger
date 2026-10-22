# AGENTS.md — notes for AI coding agents

tiktok_logger is a self-hosted, multi-user **TikTok DM logger** (insta_logger's TikTok sibling): a real Chromium runs
TikTok Web in a container, the app reads the page (DOM first, network-enriched) and stores every message and media file
encrypted — unsent messages stay readable. It also sends messages and browses the **For You feed**. A native Android
client lives in `revocx35/tiktok_logger_android`.

Read before changing anything: [ARCHITECTURE.md](ARCHITECTURE.md) (design, security model, DB, API, operations),
[docs/tiktok-notes.md](docs/tiktok-notes.md) (the TikTok Web facts the code depends on), [SECURITY.md](SECURITY.md),
[docs/DEVLOG.md](docs/DEVLOG.md) (history, lessons) and [CLAUDE.md](CLAUDE.md).

## Layout

| Path | What |
|---|---|
| `shared/api.d.ts` | The HTTP API contract (types only), shared by server, web and the Android client |
| `server/src/app.ts`, `http/`, `auth/`, `crypto/`, `db/`, `front/`, `supervisor/` | Fastify app, security hooks, login/2FA/sessions, envelope encryption, SQLite, gateway + one worker per user |
| `server/src/tt/im/` | IM protocol in the tab: `wire.ts`, `proto.ts`, `engine.ts` (import, catch-up, unsend, send), `transport.ts` |
| `server/src/tt/` | TikTok layer: `service.ts` (lifecycle, timers, tabs), `dom.ts` (messages page agent), `sender.ts`, `watcher.ts` (CDP capture), `frames.ts`/`mapper.ts`/`ingest.ts`, `feed.ts` (+`FeedCatalog`) / `feedAgent.ts` / `feedMedia.ts`, `download.ts`, `loginwatch.ts`, `cookies.ts` |
| `server/src/api/` | Routes: chats, media, send, feed, admin, settings, audit, SSE |
| `web/src/` | React UI (`pages/Feed.tsx`, `ChatView.tsx`, `Settings.tsx`, …) |
| `chromium/` | Chromium image + Go manager (per-user browsers, token-checked CDP relay, VNC tunnel) |
| `caddy/`, `deploy/`, `scripts/setup.sh` | TLS proxy, prebuilt-image compose, `.env` generator |
| `scripts/dev/` | Fake TikTok (`fake-tiktok.mts`), `dom-check.mts`, `service-check.mts` (need a Chromium) |

## Commands

```bash
cd server && PUPPETEER_SKIP_DOWNLOAD=true npm ci && npm test && npx tsc --noEmit    # 185 tests
cd web && npm ci && npm test && npm run build                                        # strict-CSP build
cd server && npx tsx ../scripts/dev/service-check.mts   # real service vs fake TikTok (headless Chromium)
```
CI publishes `ghcr.io/revocx35/tiktok_logger-{app,chromium,caddy}` on `main`. The running deployment is CT 124 on the
`zukme` Proxmox node (`/opt/tiktok_logger`, `docker compose pull && docker compose up -d`).

## Conventions

- `shared/api.d.ts` first, then server, web and the Android client.
- TikTok is the client and does all signing: the app drives and observes the page; it never signs or replays requests.
- Everything from the page is untrusted input: validate ids, cap sizes, parse defensively.
- Anything that needs the TikTok session's cookies (video CDN) is fetched **inside the page**, only for TikTok hosts.
- Diagnose the live site by attaching to the browser (read-only): `docker run --network container:<chromium> … node` with
  `ws` against `127.0.0.1:<devtools port>` in the chromium container; do not send real messages without the owner's say.
- Update ARCHITECTURE.md, this file, README and docs/DEVLOG.md in the same change.

## Never

- Send a message twice: a send whose answer was lost (`maybeSent`) must not be retried through the page.
- `JSON.parse` TikTok ids (19 digits exceed 2^53): keep them as strings / read them with a regex.
- Add a `Cache-Control` (or other non-simple) header to in-tab IM fetches: the CORS preflight fails.
- Log message text, names, cookies, tokens or media/CDN links.
- Put two tabs of one window in front of each other for different jobs: a `hidden` tab ignores key events (the feed has
  its own window for this reason).
- Download TikTok media with `Network.loadNetworkResource` and expect it to work (no cookies → 403).
- Attach to the tab while logged out (`loginwatch.ts`), weaken CSP/cookies/CSRF/the Chromium sandbox, edit old migrations.

## Gotchas

- The container runs `dist/`: tests + build do not prove it boots (CI polls `/healthz`).
- `service-check.mts` "the unsent message is kept and flagged" currently fails (also on v1.4.3) — known, unresolved.
- A page agent installed in a live tab survives an app restart: bump its `version` when its methods change.
- Opening a conversation marks it read on TikTok; do not add extra opening.
