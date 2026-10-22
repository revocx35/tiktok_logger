# AGENTS.md — notes for AI coding agents

tiktok_logger is a self-hosted, multi-user **TikTok DM logger** (insta_logger's TikTok sibling): a real Chromium runs
TikTok Web in a container and the app logs every message and media file **encrypted** — unsent messages stay readable.
Since v1.6 the messages come from TikTok's **IM protocol** driven inside the tab (protobuf, catch-up cursor, read
unsends, protocol send); the v1.0–1.5 page path remains as a fallback. It also sends messages, browses the **For You
feed** through TikTok's web API, and **logs stories** (`tt/stories.ts`, off by default). A native Android client lives in
`revocx35/tiktok_logger_android`.

Read before changing anything: [ARCHITECTURE.md](ARCHITECTURE.md) (design, security model, DB, API, operations),
[docs/tiktok-notes.md](docs/tiktok-notes.md) (the TikTok Web facts the code depends on), [SECURITY.md](SECURITY.md),
[docs/DEVLOG.md](docs/DEVLOG.md) (history, lessons) and [CLAUDE.md](CLAUDE.md).

## Layout

| Path | What |
|---|---|
| `shared/api.d.ts` | The HTTP API contract (types only), shared by server, web and the Android client |
| `server/src/app.ts`, `http/`, `auth/`, `crypto/`, `db/`, `front/`, `supervisor/` | Fastify app, security hooks, login/2FA/sessions, envelope encryption, SQLite, gateway + one worker per user |
| `server/src/tt/web/api.ts`, `tt/feedApi.ts` | Feed/comments/likes through the web API from the messages tab (page-driving `feed.ts` is the fallback) |
| `server/src/tt/im/` | IM protocol in the tab: `wire.ts`, `proto.ts`, `engine.ts` (import, catch-up, unsend, send, profiles), `transport.ts` |
| `server/src/tt/stories.ts`, `api/stories.ts` | Story logging (stories-bar + batch parsers, timer, media, retention) and its routes |
| `server/src/tt/items.ts`, `api/items.ts`, `api/messageType.ts` | One TikTok post by id for the chat cards (resolved through the tab, media proxied + ranged) and the stored-type → `MessageType` / share-card mapping |
| `server/src/tt/` | TikTok layer: `service.ts` (lifecycle, timers, tabs), `dom.ts` (messages page agent), `sender.ts`, `watcher.ts` (CDP capture), `frames.ts`/`mapper.ts`/`ingest.ts`, `feed.ts` (+`FeedCatalog`) / `feedAgent.ts` / `feedMedia.ts`, `download.ts`, `loginwatch.ts`, `cookies.ts` |
| `server/src/api/` | Routes: chats, media, send, feed, items, stories, admin, settings, audit, SSE |
| `web/src/` | React UI (`pages/Feed.tsx`, `pages/Stories.tsx`, `ChatView.tsx`, `Settings.tsx`, …); `components/TikTokCard.tsx` is the playable post card in a chat |
| `chromium/` | Chromium image + Go manager (per-user browsers, token-checked CDP relay, VNC tunnel) |
| `caddy/`, `deploy/`, `scripts/setup.sh` | TLS proxy, prebuilt-image compose, `.env` generator |
| `scripts/dev/` | Fake TikTok (`fake-tiktok.mts`), `dom-check.mts`, `service-check.mts` (need a Chromium) |

## Commands

```bash
cd server && PUPPETEER_SKIP_DOWNLOAD=true npm ci && npm test && npx tsc --noEmit    # 205 tests
cd web && npm ci && npm test && npm run build                                        # strict-CSP build (10 tests)
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
- Stories follow the same shape as the messages: parse defensively, store each item once by its id, keep identity and
  media encrypted, and **never mark a story as seen** (the tray read must stay read-only).
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

- TikTok answers a request it does not like with **200 and an empty body**; `WebApi.json` turns that into an error.
- `/api/story/user_list/` needs `cursor` even on the first page (else `400 missing required fields`); items come from
  `/api/story/batch/item_list/?authorIds=a,b,c` (≤20 authors) and photo stories carry `imagePost.images[]`, not a
  `video.playAddr`.
- The container runs `dist/`: tests + build do not prove it boots (CI polls `/healthz`).
- `service-check.mts` "media rows are queued for download" fails after the IM rewrite (`media_status` stays `none` on the
  fake path; the engine fetches private photos itself) — look at it when the media path is next touched.
- A page agent installed in a live tab survives an app restart: bump its `version` when its methods change.
- Opening a conversation marks it read on TikTok; do not add extra opening.
- **Sharing a post as a card fails silently unless two things are exact**: the IM send's envelope field 6 must be the
  message type **8 (Video)** (7 = Text is accepted with status 0 and stored nowhere), and the card's `content_thumb`
  must be the **author's avatar** (a video cover there is dropped the same way). `secUID` is camelCase, each image is
  `{url_list, uri}` with `uri` = the URL, and there is no `content_title`. `tt/im/proto.ts` (`MESSAGE_TYPE_VIDEO`) and
  `ApiFeed.share` hold both rules; `tt/feedApi.test.ts` and `tt/im/proto.test.ts` pin them.
- The IM SDK of TikTok's web client writes messages to its **WebSocket**, so `fetch`/XHR hooks capture nothing: use CDP
  `Network.webSocketFrameSent` on a tab while driving the real UI, then decode the frame (field 1 = command, envelope in
  field 8, body at 8.8.100, content JSON in 8.8.100.4).
