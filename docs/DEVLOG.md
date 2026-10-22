# DEVLOG — construction notes

## 2026-10-22 — v1.5.0: sending hung while the feed was open, feed videos 404'd, the feed was laggy

Found by attaching to the live browser on the deployment (CT 124) read-only:

* **Sending hung** (`POST /api/chats/:id/send` never completed). The messages tab and the feed tab shared one window, so
  with the feed open the Messages tab was `visibilityState: hidden`; Chromium does not ack key events for a hidden tab and
  puppeteer's `keyboard.type` waits forever. Fix: the feed gets its own **window**; both pages are `visible`
  (checked live with `Target.createTarget {newWindow:true}`: the other window's tab stays visible) and run
  `emulateFocusedPage(true)`.
* **Videos 404'd / "could not be played"**. `Network.loadNetworkResource` has no cookies; the `v16-webapp-prime` CDN answers
  403 to a URL the page had not loaded itself (the ones it had were served from the HTTP cache, which made the first test
  look fine). A `fetch(..., {credentials:'include'})` inside the page returns 200/206 in ~0.3 s. The downloader now uses
  that for the feed (ranged pieces) and falls back to the old loader. Failed downloads are logged with a reason
  (`feed media download failed`), never with the URL.
* **Lag**. Every swipe made the server scroll TikTok's real page, wait, and re-read its DOM. The answer is now built from
  the item list the page already received (`FeedCatalog.after`), so a swipe is a cheap request; the page is only moved for
  like/comments (`pin()`), and is scrolled to its end in the background when the list runs short.
* The `service-check` unsent-detection check ("the unsent message is kept and flagged") fails on v1.4.3 as well as here
  (two messages flagged instead of one) — not caused by this change, still to be looked at.

Not verified live: sending a real message (needs a recipient the owner picks) and the new feed behaviour on the deployment
(the deploy was held for the owner's go-ahead).

## 2026-10-22 — v1.2.0: the live TikTok DOM (chats and the feed had never actually been read)

The first live session showed both features empty while the browser sat on `tiktok.com/messages`, logged in. Reading
the real DOM over CDP (the manager relays the browser socket at `/i/<n>/cdp/devtools/browser/<id>`, so a small node
script can attach to the page and evaluate expressions) gave the actual structure, which none of our guessed selectors
matched:

- conversation list `[data-e2e="dm-new-conversation-list"]`, rows `dm-new-conversation-item` with the thread id in
  **`data-conv-id`** (`0:1:<uid>:<cid>` or a bare number), name `dm-new-conversation-nickname`, preview
  `[class*="SpanInfoExtract"]`; the notifications column uses `inbox-list-item` (do not read that as chats).
- message list `[data-e2e="dm-new-message-list"]`, rows `dm-new-chat-item`, text `dm-new-message-text`, media as
  `dm-new-shared-video`/`img`; **one timestamp per group** in `dm-new-time-separator` ("October 19, 2026 12:55"),
  never per message; the open conversation is the row with `aria-selected="true"` (the URL stays `/messages`).
- the feed item container is `recommend-list-item-container` **with `data-scroll-index`**, the visible item is the one
  at `top≈0`; `like-icon`/`like-count`/`comment-icon`/`video-desc` are real; but the item has **no link to its id** and
  `video.src` is a `blob:` (MSE), so the id and the signed video URL only exist in the page's
  `/api/recommend/item_list/` JSON.

Fixes: TikTok's selectors first in `dom.ts`; `data-conv-id` in `idFrom`; separator times carried into the messages that
follow them; the feed tab gets its own watcher and a `FeedCatalog` that ingests `item_list` and matches the visible
item by author + caption prefix (TikTok truncates it), which supplies the real id, `playAddr` and cover. Tests:
`feedCatalog.test.ts` (6 cases) plus the existing 134.


## 2026-10-22 — v1.1.3: the TikTok screen's "connection lost" (a rename that only reached one side)

The VNC bridge tunnels to x11vnc with an HTTP `Upgrade` whose name the Go manager compares **exactly**
(`chromium/manager/server.go`: `Upgrade: ttl-tunnel`). When the manager was renamed from `igl-` to `ttl-`, the Go
side, its tests and the docs were updated — the TypeScript client kept sending `igl-tunnel`. The manager answered
400, `openVncTunnel` rejected, the bridge closed the socket with 1011, and the screen retried every three seconds
forever, while the app itself was healthy (the browser was sitting on the TikTok login page).

`server/src/tt/chromium.test.ts` now pins the contract against a local HTTP upgrade server: header name, path
`/i/<n>/vnc`, bearer token, the `RFB 003.008` banner arriving, and a refusal rejecting instead of hanging. Verified on
the deployment afterwards with the same tunnel from inside the app container (101, then `RFB 003.008` in 200 ms).

Lesson: a protocol constant shared by two languages belongs in a test on **both** sides — the Go tests only proved
that the Go server accepts its own name.

## 2026-10-22 — v1.1.1: the feed import fix (and a CI guard)

`api/feed.ts` imported `once` from `node:stream` (it is in `node:events`). TypeScript's types include it, Node's ESM
loader does not; the unit tests only import the route module through vitest (which was happy) and the build only
type-checks, so it reached the deployment: every worker exited at boot and signup answered "your account is starting".
Fixed in v1.1.1. Root cause worth remembering: **the container runs `dist/`, so tests+build prove nothing about booting**.
CI now boots the built server in the `server` job and polls `/healthz` (v1.1.2), which is the cheapest check that
catches this whole class of late import/init errors.


## 2026-10-22 — v1.1.0: the Feed

Added TikTok's For You feed (`/feed`) as its own tab in the same browser: read the video in view (id, author, caption,
music, stats, like state), next/previous through TikTok's arrows (arrow keys as fallback), like/unlike through TikTok's
own control with confirmation, comments (read with replies, post through the composer), "send this video" into a chat,
and the video streamed through the browser to the client.

Design notes: the feed never replaces the messages tab (separate page, closed with the connection); signed CDN URLs are
replaced by 30-minute refs; the stream is full-body (no Range; Chrome plays the progressive MP4 and a Range request is
refused rather than pretending); the like is refused (409) when the feed has moved on, so a like never lands on the
wrong video; nothing of the feed is stored, and posting a comment is the only write (one audit line, no content).

Verified here: fake TikTok gained a feed page + `/api/recommend/item_list/` + like/comment endpoints; dom-check gained
12 feed checks (all pass), service-check runs the real FeedService (open, next/previous, un-like, comments with a reply,
posting, streaming) and then proves the messages tab still logs; 124 server tests and the web build stay green.
Real TikTok's For You page is, like the messages page, to be confirmed on the owner's first live session.


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
