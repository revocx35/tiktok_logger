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
| `server/src/tt/web/api.ts`, `tt/feedApi.ts` | Feed/comments/likes through the web API from the messages tab (page-driving `feed.ts` is the fallback); since v1.15 also `TtSocial`: profiles, lists, follow, repost, replies, comment likes, download, captions |
| `server/src/tt/pageActions.ts`, `api/social.ts` | Clicks on TikTok's own controls for like/repost/follow (opened through the author's profile grid) · the v1.15 routes |
| `server/src/tt/im/` | IM protocol in the tab: `wire.ts`, `proto.ts`, `engine.ts` (import, catch-up, unsend, send, profiles), `transport.ts` |
| `server/src/tt/stories.ts`, `api/stories.ts` | Story logging (stories-bar + batch parsers, timer, media, retention) and its routes |
| `server/src/tt/items.ts`, `api/items.ts`, `api/messageType.ts` | One TikTok post by id for the chat cards (resolved through the tab, media proxied + ranged) and the stored-type → `MessageType` / share-card mapping |
| `server/src/tt/schedule.ts` | Admin's per-user session schedule (on / off / scheduled + randomizer): `TtScheduler`, runs in the worker, calls `TtService.pause()/resume()` (which also stops/starts the tenant's Chromium via the manager's `POST /i/<id>/stop`) |
| `server/src/tt/` | TikTok layer: `service.ts` (lifecycle, timers, tabs), `dom.ts` (messages page agent), `sender.ts`, `watcher.ts` (CDP capture), `frames.ts`/`mapper.ts`/`ingest.ts`, `feed.ts` (+`FeedCatalog`) / `feedAgent.ts` / `feedMedia.ts`, `download.ts`, `loginwatch.ts`, `cookies.ts` |
| `server/src/api/` | Routes: chats, media, send, feed, items, stories, admin, settings, audit, SSE |
| `web/src/` | React UI (`pages/Feed.tsx` + `components/VideoStack.tsx` (the shared player), `pages/Profile.tsx`, `pages/Stories.tsx`, `ChatView.tsx`, `Settings.tsx`, …); `components/TikTokCard.tsx` is the playable post card in a chat |
| `chromium/` | Chromium image + Go manager (per-user browsers, token-checked CDP relay, VNC tunnel) |
| `caddy/`, `deploy/`, `scripts/setup.sh` | TLS proxy, prebuilt-image compose, `.env` generator |
| `scripts/dev/` | Fake TikTok (`fake-tiktok.mts`), `dom-check.mts`, `service-check.mts` (need a Chromium); `im-probe.mts`, `social-check.mts` (live, read-only unless `--act`) |

## Commands

```bash
cd server && PUPPETEER_SKIP_DOWNLOAD=true npm ci && npm test && npx tsc --noEmit    # 270 tests
cd web && npm ci && npm test && npm run build                                        # strict-CSP build (18 tests)
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
- Call like/follow/repost through the web API (`/api/commit/item/digg/` 403 "Argus TLB", `/api/commit/follow/user/`
  10402 "invalid csrf token", `/tiktok/v1/upvote/publish` ticket guard): they are clicks (`pageActions.ts`). Do not
  rebuild the ticket-guard or `x-secsdk-csrf` headers instead.
- `page.goto` a video's own page (`/@user/video/<id>`): TikTok answers it with 403 "Access denied" for this browser
  (2026-10); open the video from the author's profile grid.
- Attach to the tab while logged out (`loginwatch.ts`), weaken CSP/cookies/CSRF/the Chromium sandbox, edit old migrations.

## Gotchas

- **Session schedule (v1.16):** `TtScheduler` calls `tt.start()` once per process (it is NOT idempotent: every call reconnects and reloads the tab; a per-tick call looped the sessions on 2026-11-02). `TtService.paused` makes `start()/connect()` no-ops and `restart()/importSession()` 409. Anything new that wakes
  the TikTok session (connects, `chromium.ensure()`) must respect it, or "off" leaks. Don't add a `TtState` value for it (old Android
  clients crash on unknown enums) — it is `idle` + a detail. The phase is persisted in the tenant DB; tests inject `clock`/`rand`.

- **The look is TikTok's** (v1.14, ARCHITECTURE §5): change colours through the tokens at the top of `web/src/styles.css`
  (own bubbles = `--out` only), add icons to `components/Icon.tsx` as outline + solid `…Fill` twin when they go in the
  nav, and regenerate the Android client's `WaIcons.kt` from that file. A new class family in the markup needs a rule:
  `pages/storiesCss.test.ts` fails otherwise. `.grow` has a global `min-width: 200px` (settings forms) — never use it as
  a flex spacer in a list row (it squeezed the inbox previews to nothing). The Unsent/Search lists are `.log-*`; `.feed`
  is the For You page only (the two once shared `.feed`, which capped For You at 900 px).
- The For You list in `pages/Feed.tsx` only ever grows at the end: never cut it from the front (the scroller would jump)
  and never cap it short (a 40-item cap once ended the feed). The Android client swipes the same `/api/feed/window` +
  `/api/feed/goto` pair; `/api/feed/step` is only kept for old clients.
- Preview the web UI without a stack: serve `web/dist` from a small Node server that answers `/api/*` with fixture JSON
  (state, chats, messages, feed window, stories) and screenshot it with puppeteer at 1280×820 and 390×844, light and dark.

- TikTok answers a request it does not like with **200 and an empty body**; `WebApi.json` turns that into an error.
- `/api/story/user_list/` needs `cursor` even on the first page (else `400 missing required fields`); items come from
  `/api/story/batch/item_list/?authorIds=a,b,c` (≤20 authors) and photo stories carry `imagePost.images[]`, not a
  `video.playAddr`.
- The container runs `dist/`: tests + build do not prove it boots (CI polls `/healthz`).
- `service-check.mts` "media rows are queued for download" fails after the IM rewrite (`media_status` stays `none` on the
  fake path; the engine fetches private photos itself) — look at it when the media path is next touched.
- A page agent installed in a live tab survives an app restart: bump its `version` when its methods change.
- Opening a conversation marks it read on TikTok; do not add extra opening.
- **v1.15 live facts:** `relation` in `user/detail` lags a fresh follow (stays 0 for minutes) — `ApiFeed` remembers its
  own follow results; the browse view draws its like column ~0.5 s after the video (wait for the control); comment
  likes are `digg_type` 1/2 (0 is "Invalid parameters"); replies post with `reply_id` + `reply_to_reply_id`.
  `scripts/dev/social-check.mts` re-checks all of it against the live tab. Test actions only on a public account the
  owner agreed to (2026-10-31: @tiktok), and undo them.
- **Not done yet (owner's alt account needed for tests):** new chat, mute/pin/delete/block a chat, group chats,
  stickers/GIFs — these are IM protocol commands still to be captured from TikTok's own UI.
- **Sharing a post as a card fails silently unless two things are exact**: the IM send's envelope field 6 must be the
  message type **8 (Video)** (7 = Text is accepted with status 0 and stored nowhere), and the card's `content_thumb`
  must be the **author's avatar** (a video cover there is dropped the same way). `secUID` is camelCase, each image is
  `{url_list, uri}` with `uri` = the URL, and there is no `content_title`. `tt/im/proto.ts` (`MESSAGE_TYPE_VIDEO`) and
  `ApiFeed.share` hold both rules; `tt/feedApi.test.ts` and `tt/im/proto.test.ts` pin them.
- The IM SDK of TikTok's web client writes messages to its **WebSocket**, so `fetch`/XHR hooks capture nothing: use CDP
  `Network.webSocketFrameSent` on a tab while driving the real UI, then decode the frame (field 1 = command, envelope in
  field 8, body at 8.8.100, content JSON in 8.8.100.4).
- The worker decides "is this an /internal route" from the raw URL *and* the matched route (`req.routeOptions.url`): the
  router percent-decodes, so `/%69nternal/info` used to reach an /internal handler with only the forwarded worker token.
