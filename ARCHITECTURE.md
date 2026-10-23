# tiktok_logger — Architecture

> Source of truth for design decisions. Read this (and `docs/tiktok-notes.md`) before changing anything.
> If you change a decision, update this file in the same commit.

## 1. What it is

A self-hosted, Docker-based **TikTok direct-message logger** for one person or a few (multi-user), built on the same
server core, crypto, auth, web UI and container design as [insta_logger](https://github.com/revocx35/insta_logger)
(which came from wa_logger). A real Chromium runs `tiktok.com` in a background container; the app watches it through
the Chrome DevTools Protocol and records **every DM, its media and TikTok's own "message deleted" lines**, encrypted at
rest. When someone unsends a message, the logged copy stays viewable and is flagged.

The web UI looks like a messenger: conversation list, chat view, search, an "Unsent" feed, and a live screen of the
browser ("TikTok" in the menu) where the owner logs in and answers TikTok's checks. It can also **send** text, photos,
videos and audio as the account, by driving TikTok's own composer.

The **Feed** section (`/feed`) browses TikTok's For You feed through the same browser, in its own tab: one video at a
time with its author, caption and stats, TikTok's own like button, its comments (read and posted) and "send this video"
into one of the logged chats as the canonical link. Videos are streamed through the browser while they play; nothing of
the feed is stored (it is browsing, not the log).

**Multi-user:** the first account is the admin; the admin creates more users in the web UI (name + temporary password)
and can give each their own port. Every user is a separate tenant: own TikTok login (own Chromium, own session), own
encrypted database, own keys, own unix user. A user's data is invisible to the admin and to everyone else.

Out of scope on purpose: calls, **several TikTok accounts for one user**, starting new chats with strangers, TikTok's
"Friends"/"For You" feed browsing, and the rest of TikTok (videos, profiles, posting, comments). Unsend/edit/reaction
automation is *not* implemented (§4 "Sending").

## 2. Why it is built this way (the TikTok problem)

Instagram has a document-oriented GraphQL API with reusable document ids; wa_logger talks to WhatsApp Web's own JS
modules. **TikTok signs every request** (`X-Bogus`, `msToken`, `X-Gnarly`, device data) with JavaScript that ships in its
own bundle, and refuses requests that do not carry a valid signature for *that* URL and body. Porting a request signer
would mean shipping a copy of TikTok's obfuscated code and chasing it every few weeks.

So tiktok_logger never signs anything:

1. **The page does everything.** All TikTok traffic comes from TikTok's own client inside the container's Chromium.
2. **The app observes it** over CDP: the message-stream WebSocket (`wss://im-ws.tiktok.com/ws/v2`) and the IM API
   answers (`/api/im/…`). Frames are decoded structurally, without a schema (protobuf field walk + JSON recovery,
   `server/src/tt/frames.ts`), because TikTok's web client carries JSON payloads inside protobuf envelopes.
3. **The page is also read directly** (`server/src/tt/dom.ts`): the conversation list and the open conversation's rows.
   This is what carries the feature when a frame format changes, and it is the only way to know *what the user sees*.
4. **Sending drives the composer** like a person would (fill the box, press send), and confirms by re-reading the
   conversation.

Consequences, stated plainly: the capture is **DOM-first with network enrichment**. Server message ids and exact
timestamps come from the network when TikTok sends them; the text and the media come from whichever source has it, and
the two views of one message are merged by a content key (§4). TikTok changes its DOM from time to time, so every role
has several candidate selectors plus a heuristic, and a diagnostics screen that dumps the page's structure — the
selectors can be extended with `TT_DOM_SELECTORS` in `.env` without a new release.

**What this costs the account:** TikTok only shows a conversation to a browser that opens it, so reading history (and
re-checking for deletions) means clicking through conversations — which **marks them as read** on TikTok. There is no
way around that from the outside; it is the price of reading a chat from a browser. The import does it in the background
and pauses between conversations (`TT_REQUEST_GAP_MS`).

## 3. Containers & networks

```
                internet
                   │
          ┌────────┴────────┐   network: public (bridge)      ports 80/443 + EXTRA_PORTS published
          │      caddy      │   TLS termination (ACME or internal CA), HTTP→HTTPS; one site per extra port
          └────────┬────────┘
                   │ network: edge (internal: true)           :8080 = default; EXTRA_PORTS 8101-8110 = user ports
          ┌────────┴────────┐
          │       app       │   supervisor (root, 4 caps) ─┬─ gateway "front" (uid 10003)  the only listener
          │  (no internet)  │                              └─ worker per user (uid 10001 for the first account,
          │                 │   Node 24 · Fastify · puppeteer-core (CDP) · SQLite        10100+id for the others)
          └────────┬────────┘   volumes app_data:/data · app_users:/users
                   │ network: backend (internal: true)   tcp 9223 → chromium manager (bearer token per user)
          ┌────────┴────────┐
          │    chromium     │   manager (Go, root, 4 caps) ─ per user: Xvfb · Chromium (sandbox ON) · x11vnc
          │                 │   volume chromium_profile:/data
          └────────┬────────┘
                   │ network: egress (bridge) → tiktok.com / TikTok CDNs / the login captcha
                internet
```

* **Supervisor** (`server/src/supervisor/`): the app container's only root process (capabilities `SETUID SETGID CHOWN
  KILL`, no listener of its own). Creates directories, starts the gateway and one worker per tenant under that tenant's
  unix user, restarts with backoff, and serves a one-line-JSON control protocol on `/run/ttl/ctl/ctl.sock`.
  Workers get a minimal environment built from scratch (data dir, socket, a random per-worker internal token, the
  Chromium URL and *their own* browser token).
* **Gateway / front** (`server/src/front/`, uid 10003): the only listener. Owns the system database
  (`/users/system/system.db`: users, ports, admin log — no credentials, no content), serves the web UI, answers the
  routes that need to know who is asking before there is a session (`/api/state`, signup, login, claim, recover) and the
  admin API, and proxies everything else to the signed-in user's worker over a unix socket. Routing uses the tenant
  cookie `__Host-ttl_tenant`, which is a hint, not a credential. It sets `X-Forwarded-For/-Proto/-Host` itself from the
  configured `TRUST_PROXY` hop count, drops every client `X-Forwarded-*`/`X-TTL-*` header, only forwards plain `/api/…`
  paths, and adds the worker's token.
* **Worker** (`server/src/index.ts`, one per tenant on `/run/ttl/w/<id>/s.sock`): the app itself — own SQLite, own media
  directory, own key ring, own puppeteer connection, own sessions and rate limits. `X-TTL-Internal` is required on every
  request; `/internal/*` additionally needs `X-TTL-Scope: internal`, which only the gateway sends.
* **Ports.** The default listener is `PORT` (8080). The admin opens extra ports from `EXTRA_PORTS` (published by caddy,
  forwarded 1:1) and assigns each user one; **the port a connection arrived on decides who may sign in** (admin: default
  port only). Each port may carry the exact browser origin used there (checked on writes and WebSocket upgrades).
* **Only caddy publishes ports.** The app has no route to the internet; only chromium talks to TikTok.
* **Chromium manager** (`chromium/manager/`, Go, stdlib only): per user, on demand, Xvfb + Chromium + x11vnc, each as
  that user's unix uid, behind per-instance bearer tokens `HMAC-SHA256(CONTROL_SECRET, "ttl/chromium/instance/<id>")`.
  It relays `/json/version`, `/json/list` and the browser WebSocket only, plus an `Upgrade: ttl-tunnel` byte tunnel to
  x11vnc. CDP and VNC are never exposed.
* **Hardening** on every container: `no-new-privileges`, `cap_drop: ALL` (caddy re-adds `NET_BIND_SERVICE`; app and
  chromium re-add `SETUID SETGID CHOWN KILL` for their root supervisor/manager), read-only root filesystems with
  explicit tmpfs mounts, memory/pid limits, healthchecks. Chromium keeps its **sandbox** (`seccomp-chromium.json`);
  `--no-sandbox` exists only as the explicit `CHROMIUM_NO_SANDBOX=1` escape hatch with a startup warning.
* **Managed policy** (`chromium/policies.json`): navigation only to `tiktok.com`, `tiktokv.*`, the TikTok CDNs
  (`tiktokcdn*.com`, `ttwstatic.com`, `ibytedtos.com`, `byteoversea.com`, …), the captcha hosts TikTok's login uses
  (Arkose `arkoselabs.com`/`funcaptcha.com`, Google reCAPTCHA paths) and `about:blank`/`blob:`/`data:`. Third-party
  cookies are allowed for the captcha frames on tiktok.com (without its captcha cookie a solved captcha is rejected).
  No downloads, file pickers, printing, password manager, sign-in, sync, extensions, notifications, geolocation, camera
  or microphone.
* **Looking like a normal browser.** WebGL through Mesa's software renderer, the server's time zone (`TZ`), Kiosk at
  1280×800, and — importantly — **no debugger attached to the page while logged out** (§4): the tab list and the cookie
  jar are read over a browser-level connection instead.

## 4. App (server) — `server/`

Node 24 LTS, TypeScript (ESM), Fastify 5, better-sqlite3 (WAL), zod, puppeteer-core (CDP only). Tests: vitest.

```
server/src/
  index.ts            the tenant WORKER: config → db → crypto keyring → http (unix socket) → tt (once an owner exists)
  front.ts, front/    the GATEWAY: system DB, listeners per port, proxy to workers, admin API
  supervisor/         the SUPERVISOR (root): directories, gateway + worker processes, control socket, tokens
  api/                chats, messages, media (Range, ZIP), search, unsent feed, SSE, settings, audit, wipe, sending
  config.ts           zod-parsed env (§9); fails fast on bad config
  db/                 connection, migrations (schema §7), repositories
  crypto/             AES-256-GCM, HKDF, X25519 ECDH, scrypt; keyring (DEKs, ECIES, field encryption); chunked media
  auth/               signup, login, logout, recovery, TOTP, password; sessions; throttle
  http/               server factory, security headers/CSP, static web UI, error handler, ZIP streaming
  vnc/                authenticated WebSocket ↔ the tenant's x11vnc, through the manager's tunnel
  tt/
    service.ts        the integration: state machine, connect/teardown, loops, protocol vs page path, story timer
    im/               TikTok's IM protocol, run inside the tab: wire.ts (protobuf codec), proto.ts (the messages it
                      needs), transport.ts (fetch/evaluate bridge), engine.ts (import, catch-up, unsend, send, profiles)
    web/api.ts        TikTok's www web API from the tab (fetch hook signs it): feed, comments, stories
    feedApi.ts        the feed on top of that web API (list, swipe = index move, media cache); feed.ts/feedAgent.ts
                      are the page-driving fallback
    stories.ts        story logging: stories-bar + batch parsers and StoryLogger (timer, media, retention sweep)
    dom.ts            the in-page agent for the messages page: conversation list, rows, composer, file input
    frames.ts         protobuf walk (no schema) + JSON recovery from frames and answers; IM URL detection
    mapper.ts         whatever TikTok sent → TtThread/TtMessage (tolerant, several spellings per field)
    watcher.ts        CDP capture: IM WebSocket frames and IM API answers (passive, nothing is replayed)
    ingest.ts         encrypted writes, merging (content key), album parts, reactions, "missing" detection
    media.ts          encrypted media store + download queue through the browser
    sender.ts         page-driven sending (media uploads, fallback); confirmation by re-reading the conversation
    sync.ts           initial import and re-checks on the page path (walks conversations, pauses between them)
    cookies.ts        "log in with your own browser": cURL/Cookie-header/JSON paste, TikTok cookie allowlist
    loginwatch.ts     tab list + cookie jar without attaching to the page (login detection)
    chromium.ts       client for this tenant's browser through the manager
    browser.ts        one TikTok tab: picking it, classifying its URL, closing the others
    download.ts       media downloads inside the page (cookies included) for the CDN hosts
    feed.ts           page-driving feed fallback: own tab/window, current/next/previous, like, comments
    feedAgent.ts      the in-page agent for that fallback (item, controls, comments panel) + selector candidates
```

Routes for all of this live in `server/src/api/` (`feed.ts`, `stories.ts`, `chats.ts`, `media.ts`, `send.ts`, `state.ts`).

### State machine (`service.ts`)

`idle → starting → login/challenge → starting → syncing → ready`, with `error` for a lost browser (retry with backoff).

### Two paths: the IM protocol (normal) and the page (fallback)

Once the tab is attached, `startEngine()` probes TikTok's IM protocol (`tt/im/`, protobuf on `im-api-sg.tiktok.com`,
called with `credentials:'include'` from the tab). When it answers, everything is protocol-driven:

* **catch-up** every 5 s from the stored cursor (`get_by_user_combo`, 50 rows/page, two lanes) — the cursor is rewound
  90 s and ingest is idempotent, so nothing is lost or doubled;
* **unsends are read** (`s:is_recalled` placeholders in `get_by_conversation`), not inferred from what vanished;
* **the socket** (`im-ws-sg…/ws/v2`) is LZ4 + protobuf and yields typed events (chat, recall, reaction, receipt, typing);
* **sending** is `/v1/message/send` with a per-send DPoP proof (text, `aweType` 703 replies, `aweType` 800 shared-post
  cards), reactions are `/v1/message/set_property` (705/10008, `action_flag` 2 in a group); media uploads still go
  through the page; a card TikTok silently drops is detected by reading the conversation back and the link is sent
  instead. **Sharing a post as a card is two rules that both fail silently** (verified live 2026-10-23 by sending each
  variant into a chat and reading it back; TikTok answers status 0 and stores nothing otherwise):

  1. **The envelope's field 6 is the message type** — `Text` 7, `Video` 8, `Story` 1025 (private image 1802). A share
     goes out as **Video**; the same body as Text is dropped.
  2. **The card's `content_thumb` is the author's avatar**, not the video's cover. The rest of the body is what TikTok's
     own web client builds: `{"aweType":800, itemId, uid, secUID, content_thumb:{url_list,uri}, content_name,
     cover_url:{url_list,uri}, cover_width, cover_height}`, `uri` being the URL itself and no `content_title`. The cover
     goes in `cover_url`.

  Method that found it, worth reusing: TikTok's web client sends DM writes over its **WebSocket**, so a `fetch`/XHR hook
  records nothing (`tt/im/` capture for reading frames is separate). Capture with CDP `Network.webSocketFrameSent`
  while driving the real "Share to" panel (share icon → recipient → Send), then decode: frame field 1 = command
  (10004 = send), envelope at 8, message body at 8.8.100 (`1` convId, `2` conversation type, `3` sourceId, `4` content
  JSON as plain text, `5` tags, `6` message type, `7` "deprecated", `8` client id);
* **profiles** (`/tiktok/v1/im/user/profile/`) name chats and group senders and fill the avatars.

When the probe fails (or the origin is the test double) the v1.0–v1.5 page path runs unchanged: poll the open
conversation every 2.5 s, import by opening conversations, infer unsends with the "missing" rule (which needs the
read-completeness guards described below and in `tt/ingest.ts`). The web API (`tt/web/api.ts`) is bound on the protocol path; stories and
the API feed need it.

### Chat post cards (`tt/items.ts`, `components/TikTokCard.tsx`)

A shared video is a `shared_post` in the IM protocol (`aweType` 800: `itemId`, the author's `uid`, the card fields) and
every such row is stored with that type. Two things were missing, and together they made a shared video look like "just
a link" in the chat: the API cast the stored type straight into `MessageType` (so `shared_post` matched nothing in the
web UI's render switch, and no share info was built), and nothing resolved the post itself.

* `api/messageType.ts` translates the stored types (`shared_post` → `share`, `media` → `video`/`voice`/`image` by the
  stored mime, `unsupported` → `unknown`) and builds the `ShareInfo` from the IM meta — `itemId`, the canonical URL
  (`https://www.tiktok.com/@_/video/<id>` when only the id was kept), the post title as the card title. It is pure and
  unit-tested; the mapping was the whole bug.
* `tt/items.ts` resolves one post by id through the tab: `GET /api/item/detail/?itemId=…` (the call TikTok's own web
  client makes). Live shape: `itemInfo.itemStruct` with `desc`, `author{uniqueId,nickname,id}`, `stats`, and
  `video{playAddr,cover,duration,width,height}`; an id TikTok does not have answers 200 with `statusCode: 10204` and no
  `itemStruct` → 404. Answers are cached 10 minutes (300 entries).
* The video and the cover are downloaded **through the page** (the CDN needs the tab's cookies) into the same
  byte-bounded cache the feed uses, and served by `/api/items/:id/media/{video,cover}` with `Content-Length`, Range
  (206) and an ETag — a phone will not play a video that cannot be ranged. The signed CDN link never reaches the
  browser.
* The web card (`TikTokCard`) is used when a message has `share.itemId` **or** its text contains a TikTok video link
  (`lib/ttLinks.ts`), which is what the send fallback produces when TikTok drops the card (see §4 sending). It resolves
  only when the card scrolls into view (a chat can hold hundreds of shares), shows the cover and a play button, and
  swaps in a ranged `<video>` on click. When the post cannot be resolved (deleted, private, region-locked) the card
  degrades to a link out to TikTok.

Limits, stated plainly: TikTok still **drops** the shared-post card the app sends (v1.9.4/1.9.5 verified it through the
conversation read-back), so the recipient sees the canonical link in TikTok's own clients — the playable card is this
app's view of that post. A short `vm.tiktok.com` link carries no id and is not followed (no outbound requests), so it
stays a plain link. The Android client shows shares as text (it has no card yet).

### Story logging (`tt/stories.ts`)

Off by default (`settings.storyLogging`). Own timer: the first pass three minutes after a worker becomes ready, then
`storyIntervalMinutes` (15–240, default 45) ± a quarter of it at random. One pass:

1. the stories bar — `GET /api/story/user_list/?count=10&cursor=…` (the `cursor` parameter is **required even on the
   first page**; without it TikTok answers `400 missing required fields…`), page by page, authors upserted with their
   username/nickname encrypted and their avatar link stored for a later fetch;
2. items — `GET /api/story/batch/item_list/?authorIds=a,b,c` for up to twenty authors per call (1.2 s apart), each item
   inserted once by its id (pending) with `taken_at`, `expires_at`, likes and plays. A **video** story has
   `video.playAddr`; a **photo** story has no play address and its pictures are `imagePost.images[].imageURL.urlList[]`
   — `imageURL` is an **object**, not a string (v1.12.1: treating it as a string dropped every photo story silently,
   so only video stories were ever logged), with `imagePost.cover` as the last-resort link;
3. media — for each pending row the pass re-asks the author's batch for the signed link and downloads it through the
   page into the ordinary encrypted media file (`kind = 'story'`), up to `mediaMaxMb`; three attempts, then `failed`;
4. avatars — a few per pass, refreshed daily;
5. retention — stories older than `storyRetentionDays` (1–365) are deleted with their files.

A manual check (`POST /api/stories/check`, the Stories page's "Check now") runs even while the schedule is off. Nothing
is ever marked as seen: the tray read does not open a story in TikTok's sense. The `stories checked` log line carries a
`perAuthor` array (author id, item count, `v`/`i` per item type) so a story that did not arrive can be traced from the
log instead of guessed at. A pass is logged when it starts, a pass that finds the previous one still running logs a
warning (with its age) instead of returning silently, and the whole pass runs under a ten-minute timeout so a hang can
never keep the schedule dead until the next restart.
* While logged out: **nothing is attached to the tab.** `lookAtTab()` reads the tab list and the cookie jar over a
  browser-level CDP connection; a session cookie (`sessionid`/`sessionid_ss`/`sid_tt`) plus the tab not being on a
  login/check page is what flips the state to attaching. The tab is pointed at `/login` (TikTok's own pages redirect
  there), and reloaded once, so cookies set meanwhile take effect. The owner logs in on the TikTok screen (noVNC) — or
  pastes a session from their browser (`POST /api/tt/session`).
* On attach: install the DOM agent in every document, start the Watcher, **reload the page once** (so the initial IM
  answers — conversation list with peer ids, open conversation — are captured by the watcher, not missed), read the
  account id (the page's hydration data, else the cookie jar), import, then `ready`.
* `ready` loops:
  * **poll (2.5 s):** the open conversation's rows are read and stored (DOM path); conversation list every 15 s.
  * **re-check (`settings.reconcileMinutes`, default 10):** the newest 10 conversations plus any with unread messages
    (at most 15) are opened, read, and compared with what is stored — messages the page no longer shows are flagged
    `missing` (anti-delete). Reloads the tab if nothing at all arrived for 20 minutes.
  * **session refresh (`settings.sessionRefreshHours`, default 2 h ± 20 min):** reloads the tab like a person returning
    to it. The re-check after catching up fills the gap.
* Every page operation goes through one promise chain (`run()`): one puppeteer page, one operation at a time.

### Capture

* **Watcher** (`watcher.ts`): `Network.enable` on a CDP session of the app's own. It records
  `webSocketFrameReceived/Sent` for sockets whose URL matches `im-ws*.tiktok.com` or `/ws/v2`, and the bodies of
  answers to IM URLs (`/(api/)?(im|dm|messaging|chat|conversation|thread|mail)\b` on tiktok.com/tiktokv.*), bounded
  (4 MB per frame/body, 200 tracked requests). Nothing is written into the page and no request is replayed.
  In test setups only (`TT_WEB_ORIGIN` ≠ tiktok.com) the fake origin's `/api/im/` answers count too.
* **Decoder** (`frames.ts`): `walkProto` reads a buffer as a protobuf message structurally (field number, wire type,
  value, recursing into length-delimited fields that parse completely), `extractJson` finds JSON objects in any text
  with a brace matcher. TikTok's web client carries its IM payloads as JSON inside protobuf envelopes; both an envelope
  and a plain JSON answer are handled, and everything is bounded because all of it is untrusted.
* **Mapper** (`mapper.ts`): every field is optional and looked up in several spellings (`conversation_id`/`conversationId`
  /`cid`, `create_time`/`createdAt`/`timestamp`, `content` as JSON string with `text`, `sender.uid`/`nickname`, media
  `url_list`, …). It returns `null` rather than guessing: a message needs a conversation id, a plausible timestamp and
  something to show. Records that are storable but unreadable are kept as `unknown` with `meta.unreadable` instead of
  being dropped silently.
* **DOM agent** (`dom.ts`): every role (conversation list/row/name/preview/unread/avatar, message list/row/text/time,
  composer, send button, file input, "deleted" hint) has a list of candidate selectors (TikTok's own `data-e2e`
  attributes first), then a heuristic: the most message-like list, the widest text container, an own message recognised
  by class/alignment against the pane's right edge (never by position alone), the composer as the last visible
  `contenteditable`, the send control by selector or label, Enter as the last resort. It reads only; sending is driven
  through the same agent.
* **Which conversation is open:** the URL when TikTok puts an id there, else the row that was clicked (marked
  `data-ttl-open`), else the row the page marks as selected, else the header name.

### Ingest (`ingest.ts`)

* **Identity.** A message's primary key is TikTok's server id when we have it, else `srv:<hash of its content>`. A
  `dedupe_key` = hash(chat ‖ sender ‖ minute ‖ type ‖ text ‖ media URL without its query) is stored on every row: when
  the same message is first read off the page and later arrives through the network, the two meet on that key (or on
  "one synthetic row of the same chat and sender within five minutes"), the row is kept and `alt_id` gets the server id.
  The network record's exact timestamp and type replace the page's estimate (`source` becomes `live`/`history`).
* **Own messages**: `fromMe` comes from the row's side (DOM) or the sender id (network). In a one-to-one chat an
  incoming message with no named sender is attributed to the chat's peer, so both views hash the same.
* **Albums**: a message with several photos/videos is stored as the message plus `<id>~1`, `<id>~2`, … (each with its
  own media), as wa_logger/insta_logger do.
* **Media** goes to the download queue through the browser (`Network.loadNetworkResource`, no cookies, size cap); the
  signed CDN URL lives in memory only.
* **Anti-delete.** Within a re-read range, stored messages the page no longer shows are flagged `deleted_by='missing'`
  (only messages older than 60 s, and only strictly inside the range: the oldest visible row is the boundary of what the
  page rendered, so it is not judged). TikTok's own "message deleted" line is stored as a `system` message. Nothing is
  ever hard-deleted by TikTok: the row and its media stay.

### Sending

* `api/send.ts` → `tt/sender.ts` → the DOM agent: open the conversation, fill the composer (`execCommand('insertText')`
  for a contenteditable, native setters for input/textarea), press the send control (or Enter), then poll the
  conversation for up to 15 s for a row of ours with that text (or with media) and store it as `sent`.
* Files: the bytes go into the page as base64 and become a `File` on TikTok's own `<input type=file>` through a
  `DataTransfer` (no shared filesystem, no upload API of ours); TikTok's client uploads it; we press send and store our
  own bytes locally so no download is needed.
* Limits: route rate limits plus 200 sends/hour; audited as `message_sent` (type only). Text ≤ 2000 characters.
* **Not supported, on purpose:** unsend, edit, reactions. Their UI in TikTok's web client is localized, menu-driven and
  changes often; the API answers `not_supported` with a clear message and the UI hides those actions. Edit does not
  exist on TikTok at all.

### IM protocol (`tt/im/`, v1.6+)

Reading and sending go through TikTok's own IM API **from inside the tab** (`transport.ts` → `page.evaluate(fetch)`),
exactly like insta_logger's in-tab GraphQL; the container has no internet and TikTok's cookies/origin are the tab's.
`wire.ts` (protobuf reader/writer, LZ4 block), `proto.ts` (requests, answers, socket frames, content JSON), `engine.ts`
(`ImEngine`: first import, catch-up, unsend check, live frames, send, mark-read, profiles), `transport.ts`.

* **Live:** the Watcher hands every inbound socket frame to `ImEngine.handleFrame` (typed events). **Catch-up:** every 5 s
  `get_by_user_combo` from the stored cursor (state `im_state`: cursors + conversation short ids). **Unsends:** a recall frame
  flags the message at once (`deleted_by='sender'`); every `reconcileMinutes` the newest 15 chats' latest 50 messages are
  re-read and `s:is_recalled` placeholders flag the rest. Nothing is opened in the page, so nothing is marked read by logging.
* **Send:** `sendText` builds the type-100 request, DPoP-signs it with a fresh P-256 key (`ticketGuard`), stores the
  message under TikTok's id. A refusal is "not sent"; a lost answer is `maybeSent` and is **never** retried through the
  page (it could double-send). Media sends still use the page (`sender.ts`).
* **Fallback:** if `ImEngine.probe()` fails the page-driving path (dom.ts, sync.ts, sender.ts) runs as before.
* Threat model: all IM answers are untrusted input (bounded readers, 19-digit ids kept as strings, hosts checked before
  cookies are attached, DPoP key never leaves the process).

### Feed through the web API (`tt/feedApi.ts`, `tt/web/api.ts`, v1.7+)

When the protocol engine is active the feed and its comments use TikTok's web API from the messages tab instead of a feed
page: `ApiFeed` (item list → `FeedCatalog`, index moves, `comment/list`, `comment/publish`) over `WebApi` (the page's
own `fetch`, which TikTok's hook signs). `routedFeed` in service.ts sends reads to the page-driving `FeedService` below only
if the API fails.

**Likes are the one exception: they are made by clicking TikTok's own control, never through the web API** (v1.12.0).
`POST /api/commit/item/digg/` answers **403 `Web SDK blocked by Argus TLB Plugin`**: TikTok's SDK stamps
`tt-ticket-guard-*` headers (`client-data`, `public-key`, version) onto the requests it makes itself, and a plain `fetch`
from the page does not get them — every parameter variant (`aweme_id`, `item_id`, with/without `type`/`from_page`)
answered 403, while a click on the page's like control answered 200 and moved the count. So `ApiFeed.like` delegates to
`FeedService.likeOnVideo`, which puts the video on screen and uses `FeedAgent.like`:
the item is used in place when the page's For You list already renders it, otherwise the feed window opens the video's own
page (`/@author/video/<id>`, `videoPageUrl`) — our order comes from the API, the page's is its own, so an item further
ahead cannot be reached by scrolling. Both paths read the state back from `aria-pressed` on the like button and report
what the page shows, and a 409 (`feed_moved`) from the page reaches the client unchanged. Comments were checked in the
same pass and are **not** blocked (a publish with a bogus id answers 200 + `status_code`), so they stay on the API.

### Feed, page-driving fallback (`tt/feed.ts`, `tt/feedAgent.ts`, `api/feed.ts`)

* **Its own window.** The feed is opened in a second *window* (`newPage({type:'window'})`, `/<origin>/foryou`) on first use,
  so the messages tab keeps its position, its stream socket and its "who is on screen" state. It must be a window and not a
  tab: in one window the tab that is not in front is `visibilityState: hidden`, and a hidden tab never acknowledges
  `Input.dispatchKeyEvent` — typing a message while the feed was open hung until the feed was closed (v1.4.x bug; the
  Messages tab was `hidden` while `/foryou` was `visible`). Both pages also run `emulateFocusedPage(true)`.
* **Where the videos come from.** `FeedCatalog` ingests the page's `/api/recommend/item_list/` answers: id, signed
  `playAddr`, cover, caption, author card, counts and `digged`, in the order TikTok will show them. `window()`/`goto()` are
  answered from it (`after(id, n)`), so a swipe does **not** touch TikTok's page; the page is only moved when something has to
  act on a video (`pin()` walks it with `edge('start'|'end')` until the item is rendered). When fewer than 6 videos follow
  the one on screen, `extendIfShort()` scrolls the page to its last rendered item, which makes TikTok load the next batch.
* **Reading the page** (`current()`, only for the first window and for actions): the agent finds the item container under the
  middle of the viewport; the id is `data-more-menu-item-id`, the author the avatar's `/@name` link, counts are parsed
  (`1.2K`). The like state comes from the like control's `aria-pressed`/class.
* **Liking** clicks the like control and polls the page until the state matches (the catalog remembers it: `markLiked`);
  a feed that cannot be walked to the video is a 409, never a like on the wrong video.
* **Comments** open TikTok's panel, read the rows (and their replies), and post by filling the box and pressing the
  post control (Enter as a fallback). The service confirms the new comment appears before answering.
* **Video** is downloaded once, in the page, with `fetch(url, {credentials:'include'})` in 2 MB ranged pieces
  (`BrowserDownloader(page, true)`), and cached in memory (320 MB, the next 3 videos are warmed). `Network.loadNetworkResource`
  has no cookies and TikTok's video CDN answers **403** to it unless the page had loaded that exact URL (HTTP cache) — that
  was the "video could not be played" / repeated 404s. Only TikTok hosts (`isTikTokCdn`) are fetched with the cookies. The
  ref is a random handle to the signed URL, so TikTok links never reach the browser. Served with Range support.
* **Sharing** is the UI sending the canonical `https://www.tiktok.com/@user/video/<id>` into a chat through the normal
  send path — the log then contains it like any other link message.
* Nothing from the feed is stored; posting a comment adds one audit line (`feed_comment`, no content).

## 5. Web UI — `web/`

React 19 + Vite + TypeScript SPA, built into the server's static assets. No CDN, no external fonts, no inline scripts
(strict CSP). `@novnc/novnc` for the TikTok screen, `qrcode` for TOTP enrollment.

Routes: `/signup`, `/login`, `/recover`, `/setup/recovery`, `/setup/link`, `/` (chats), `/chat/:chatId`, `/feed`
(For You), `/stories` (logged stories), `/deleted` ("Unsent"), `/search`, `/tiktok`, `/settings`, `/admin`. A route guard
uses `GET /api/state`.

Chat view: date separators; sender names in groups; text rendered as text (links and @mentions only, never HTML);
quoted replies; media grid with lightbox, video player, audio player; a shared TikTok post (or a pasted TikTok link) as
a card with the post's cover, author and a player (`components/TikTokCard.tsx`, see §4 "Chat post cards"); select
photos/videos → one ZIP; infinite scroll; SSE live updates; per-chat and global search; composer with text, photo/video/
audio and voice recording (MP4 or Ogg/Opus). Light and dark themes, single pane under 900 px.

Feed (`pages/Feed.tsx`): a full-height stage with the video (muted by default, click to unmute), author/caption/music and
stats, a rail with like / comments / send / mute / open-on-TikTok, up/down arrows and `↑`/`↓` or `J`/`K`, a comments
panel with replies and a composer, and a chat picker for "send this video".

Stories (`pages/Stories.tsx`): a row of authors in gradient rings with their story counts, a tile grid (a video frame or
the photo, a caption and a badge while it downloads), a full-screen 9:16 viewer (bounded by both the screen width and
92 % of its height) that plays videos, holds photos five seconds and steps with ← / →, and "Check now". Settings →
Logging also holds the story toggle, interval, retention and the per-account picker. The page's class names are pinned
to the stylesheet by `pages/storiesCss.test.ts` (see §10).

Settings → Logging holds the media/history limits, session refresh and the re-check interval; Settings → TikTok holds
the connection, the session paste panel and **Diagnostics** ("Check what is being read" / "Show the page's structure"),
which is the tool for fixing a selector drift.

## 6. Security model

**Threats considered:** internet attackers at the login page, CSRF/XSS against the owner's browser, hostile message
content (HTML/SVG/scripts in messages or media), theft of disk or backups, lateral movement between containers, brute
force, abuse of sending, and the owner's pasted TikTok session (a credential).

**Accepted / out of scope:** a fully compromised host (it can read process memory and the live TikTok login), and
TikTok's terms of use (an automated browser; the restriction risk is the user's decision).

### Authentication

* Signup is closed permanently once an owner exists and needs `SETUP_TOKEN` (constant-time compare, rate limited).
* Password ≥ 12 characters, max 256, rejected if it matches the username or a small common list.
  `master = scrypt(pw, salt32, N=2^17, r=8, p=1)`, `authHash = HKDF(master, "ttl/v1/auth")` (stored),
  `KEK = HKDF(master, "ttl/v1/kek")` (never stored).
* Optional TOTP (RFC 6238, ±1 step, replay-protected by storing the last used step; the secret is encrypted under a key
  derived from the KEK).
* Recovery key: 32 random bytes shown once as Base32 groups, wrapping a second copy of the private key. Recovery needs
  the recovery key **and** a new password; it disables TOTP and rotates the key.
* Brute force (`auth/throttle.ts`): every credential check is charged *before* scrypt runs, so parallel requests cannot
  race past a lock; per IP (5 failures → 30 s … 1 h) plus a global per-account counter (50 failures → 1 attempt per
  30 s … 15 min). Recovery only uses the per-IP limit and resets the global one.
* TOTP codes are consumed atomically; enabling 2FA needs the password. After password/2FA changes and recovery the WAL
  is checkpointed and truncated (`secure_delete=ON`) so superseded key wraps do not linger.

### Multi-user isolation

* A tenant is a unix user with its own directories, database, keys and browser. The gateway holds only the user list
  (names, ports, disabled flag, connection *state*), never a key or a piece of content.
* Only the gateway listens; workers listen on a unix socket in a `tenant:front 0710` directory and require their random
  `X-TTL-Internal` token on every request (constant-time compare before routing).
* The tenant cookie is a routing hint, not a credential; port pinning is enforced on every request and upgrade; an admin
  moving/disabling a user closes that user's streams.
* Destructive admin actions (reset, delete) require the admin's password and, when enabled, the 2FA code, and are
  audited. The admin never sees content, chats, contacts or media.
* Residual risk: all browsers share the chromium container's network namespace (a full sandbox escape as one user could
  reach another's loopback DevTools port), and the app's root supervisor is trusted. Both are small, trusted components.

### Sessions, CSRF, hardening

* Cookie `__Host-ttl_session` (`Secure; HttpOnly; SameSite=Strict; Path=/`), value `b64url(sid32).b64url(secret32)`; the
  DB stores `sha256(sid)` and the private key encrypted under `HKDF(secret, "ttl/v1/session")` — **a DB dump without a
  live cookie cannot decrypt anything**. Idle timeout 8 h, absolute 7 days, listable/revocable sessions.
* "Is this an API request?" is decided from the matched route, never the raw URL. Non-GET `/api` requests need
  `Content-Type: application/json` and a matching `Origin`, plus `X-CSRF-Token = HMAC(HKDF(secret,"ttl/v1/csrf"), "csrf")`.
  WebSocket and SSE require the session cookie and a matching Origin. Requests whose TCP peer is the chromium container
  are refused.
* CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:;
  connect-src 'self'; object-src 'none'; frame-ancestors 'none'`; HSTS when secure, `nosniff`, `no-referrer`,
  `Permissions-Policy`, COOP/CORP, `Cache-Control: no-store` on `/api/*`. Media responses: an inline-safe MIME
  allowlist, everything else as an attachment with `Content-Security-Policy: sandbox`.
* Message text is never rendered as HTML; no link previews are fetched; zod validates every body/query/param; errors are
  generic and internal details never leave the server; logs never contain message content, names, cookies or secrets.

### Data from the TikTok tab

* The page (TikTok Web, or whatever runs in that tab) can feed the app arbitrary frames and answers. Everything is
  untrusted: frames/answers above 4 MB are ignored, the protobuf/JSON readers never throw on garbage and are bounded,
  ids are validated by pattern before they become keys or URL parts, content is stored encrypted and rendered as text.
* Media is fetched **only** from `https` URLs on TikTok CDN hosts (`tiktokcdn*.com`, `ttwstatic.com`, `tiktokv.*`,
  `ibytedtos.com`, `byteoversea.com`, …) by the browser, with size caps and timeouts; the Content-Type is only trusted
  when it is a known media type.
* Signed CDN links are bearer links to private files: they live in memory only, never in the database or logs.
* TikTok session cookies never leave the tab; nothing is replayed or re-signed by the app.
* The tab is kept on the messages page; our media downloads send no cookies (`includeCredentials: false`).

### Encryption at rest (envelope, public-key)

* At signup: an X25519 keypair. The public key is stored in plaintext; the private key is AES-256-GCM encrypted under
  the password KEK and, as a second copy, under the recovery KEK.
* **DEK** (data key): random 32 bytes, created at each process start and rotated every 24 h, wrapped with ECIES to the
  owner's public key and stored in `data_keys`. Only the current DEK is kept in memory for writing.
* **Fields:** `0x01 ‖ keyId(u32be) ‖ nonce(12) ‖ ciphertext ‖ tag(16)`, AES-256-GCM with
  AAD = `"ttl/v1|<table>|<column>|<rowId>"`, which stops ciphertexts being swapped between rows or columns.
* **Media:** header + 64 KiB chunks, each AES-256-GCM with a per-chunk nonce and AAD that includes the chunk index and
  the final flag (Range requests decrypt only the needed chunks; truncation/reordering is detected). Files are stored
  under random names (`/data/media/<2 hex>/<uuid>.bin`).
* **Encrypted:** message bodies, `meta` JSON (share card, sticker name, unknown type name, sender name), reaction emoji,
  chat names, contact names and usernames, all media (including avatars) with MIME type and filename.
* **Plaintext (metadata, documented):** conversation/message/user ids, timestamps, message types, flags
  (deleted/edited/forwarded/view-once), album position, media sizes/dimensions, the dedupe key. Host full-disk
  encryption is recommended.
* A lost password plus a lost recovery key means **the data is gone by design**.

## 7. Databases

Two SQLite databases, both WAL, `foreign_keys=ON`, `secure_delete=ON`:

* **Tenant database** — `/data/tiktok_logger.db` (first account) or `/users/<id>/tiktok_logger.db`.
* **System database** — `/users/system/system.db`: `users(id, username, role, disabled, port, …)`, `listeners(port,
  public_origin)`, `audit(...)`. No credentials, no keys, no content.

### Tenant database

```sql
owner, sessions, audit_log, app_state, data_keys, media      -- auth, keys, encrypted media files
chats(id TEXT PRIMARY KEY /* conversation id */, kind /* user|group */, thread_id, peer_id, name_enc, last_ts,
      folder, pinned, muted, removed_at, avatar_media_id, avatar_checked_at, created_at, updated_at)
contacts(id TEXT PRIMARY KEY /* TikTok uid */, user_id, username_enc, name_enc, is_me, is_verified,
         avatar_media_id, avatar_checked_at, updated_at)
messages(id TEXT PRIMARY KEY /* server id or srv:<hash>; album parts "<id>~n" */, alt_id, dedupe_key, chat_id,
         sender_id, from_me, ts, type, body_enc, meta_enc, quoted_id, media_id, media_status, media_attempts,
         media_size, media_w, media_h, media_duration, album_index, album_count, is_view_once, is_forwarded,
         expires_at, ack, deleted_at, deleted_by, edited_at, last_edit_key, source, captured_at, updated_at)
  INDEX (chat_id, ts), (deleted_at), (media_status='pending'), (media_id), (alt_id), (dedupe_key)
message_edits(id, message_id, body_enc, captured_at)
reactions(message_id, sender_id, emoji_enc, ts, removed_at, PRIMARY KEY(message_id, sender_id))
-- migration 2 (multi-user): an admin-issued temporary password (mode 'new': no owner row yet; mode 'reset': the
-- owner row is kept and the data stays)
pending_claim(id CHECK (id = 1), username, mode, salt, auth_hash, failed_logins, locked_until, created_at)
-- migration 3 (stories): story logging
story_users(id TEXT PRIMARY KEY /* TikTok uid */, username_enc, name_enc, avatar_url, avatar_media_id,
            avatar_checked_at, last_story_at, created_at, updated_at)
stories(id TEXT PRIMARY KEY /* story item id */, user_id, type /* image|video */, taken_at, expires_at, media_id,
        mime_enc, likes, plays, status /* pending|downloaded|failed|too_large */, attempts, captured_at)
  INDEX (taken_at), (user_id, taken_at), (status)
```

Migrations are append-only (`server/src/db/db.ts`). `app_state` keys: `settings`, `onboarding_complete`,
`initial_sync_done`, `im_state` (IM cursors and conversation ids). Media `kind`: `message`, `avatar`, `story`.

## 8. HTTP API (JSON; DTOs in `shared/api.d.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/state | – | `{hasOwner, authenticated, onboardingComplete, csrfToken?, tt?}` |
| POST | /api/auth/signup · login · logout · logout-all · recover · password | | as in wa_logger/insta_logger |
| GET/DELETE | /api/auth/sessions[/:id] | ✓ | list / revoke |
| POST | /api/auth/totp/setup · enable · disable · /api/auth/recovery-key/rotate | ✓ | TOTP, recovery key |
| GET | /api/tt/status | ✓ | `TtStatus` (state, detail, account, sync progress, media queue, last live update) |
| POST | /api/tt/restart · /api/tt/logout | ✓ | reload the tab / log the browser out of TikTok |
| POST | /api/tt/session | ✓ | `{cookies}`: log in with a session from the owner's own browser |
| GET/POST | /api/tt/diagnostics · /api/tt/probe | ✓ | capture counters and recent IM paths · the page's structure |
| POST | /api/onboarding/complete | ✓ | requires state ready/syncing |
| GET / WS | /api/vnc/credentials · /api/vnc | ✓ | noVNC password · bridge to the browser's screen |
| GET | /api/feed | ✓ | `{item}`: the video in view (`FeedItem`, media as app URLs) |
| GET | /api/feed/window?limit=3 | ✓ | `{items,current}`: the video in view plus the next few (the clients swipe these) |
| POST | /api/feed/goto | ✓ | `{id}` → `{items,current}`: move the remote page to a swiped-to video |
| POST | /api/feed/:id/share | ✓ | `{chatId}`: share the video as a TikTok card (the link is sent when TikTok drops the card) |
| POST | /api/feed/step | ✓ | `{dir: next\|prev}` → `{item}` |
| POST | /api/feed/:id/like | ✓ | `{like}` → `{liked}` (TikTok's own control) |
| GET · POST | /api/feed/:id/comments · /api/feed/:id/comment | ✓ | `{comments}` · posts `{text}` (≤150) |
| GET | /api/feed/media/:ref | ✓ | the video/poster/avatar from the server's cache, with `Content-Length`, Range (206) and an ETag |
| GET | /api/items/:id | ✓ | `TtItem`: one post resolved through the tab (`/api/item/detail/?itemId=`), its media as app URLs |
| GET | /api/items/:id/media/video · /media/cover | ✓ | the post's video (ranged, 206) or cover, downloaded once through the page and cached |
| GET | /api/stories/status · /api/stories/authors · /api/stories/accounts · /api/stories?user=&before=&limit= | ✓ | story logging status, authors with items, every account seen in the bar, `StoryPage` |
| POST | /api/stories/check | ✓ | runs a pass now (also while the schedule is off) |
| GET | /api/chats | ✓ | `ChatSummary[]` |
| GET | /api/chats/:chatId/messages?before= · /messages/around/:messageId · /messages/after?after= | ✓ | `MessagePage` |
| GET | /api/messages/:messageId · /edits | ✓ | one message · edit history |
| POST | /api/messages/:messageId/media/retry | ✓ | re-queue a download |
| GET | /api/media/:mediaId (Range) · /api/media-zip?ids= · /api/media-feed?after= | ✓ | files |
| GET | /api/deleted?before= · /api/search?q=&chatId= | ✓ | unsent feed · search |
| POST | /api/chats/:chatId/send · /api/uploads (raw) · /api/chats/:chatId/send-media · DELETE /api/uploads/:id | ✓ | sending |
| POST | /api/messages/:messageId/react · unsend · edit · /api/chats/:chatId/read | ✓ | react goes through `/v1/message/set_property` (705/10008); unsend/edit are `not_supported` (§4) |
| GET | /api/admin/overview · /api/admin/audit | ✓ admin | users, ports, admin log (gateway) |
| POST | /api/admin/users · /api/admin/users/:id/reset · /delete | ✓ admin | create with temporary password · reset · delete |
| PATCH | /api/admin/users/:id | ✓ admin | move to another port, disable/enable |
| PUT/DELETE | /api/admin/ports/:port | ✓ admin | open/close an extra port, set its browser origin |
| POST | /api/auth/claim · /api/auth/verify · /api/auth/ping · GET /api/auth/whoami | | claim a temporary password · re-check the password |
| GET/POST | /internal/* (provision, info, signup, reset, revoke-sessions, unlink) | gateway only | token + scope header |
| GET | /api/events | ✓ | SSE: `tt_state`, `message`, `message_update`, `chat_update`, `sync_progress`, `session_revoked` |
| GET/PUT | /api/settings | ✓ | `{downloadHistoryMedia, mediaMaxMb, historyPerChat, readReceipts, sessionRefresh, sessionRefreshHours, reconcileMinutes, storyLogging, storyIntervalMinutes, storyRetentionDays, storySelected}` |
| GET | /api/audit · POST /api/data/wipe | ✓ (+ password) | audit log · delete all logged data |

## 9. Configuration (`.env`, generated by `scripts/setup.sh`)

`SITE_ADDRESS`, `CADDY_TLS`, `PUBLIC_ORIGIN`, `SETUP_TOKEN`, `COOKIE_SECURE`, `CADDY_CONFIG`, `HTTP(S)_PORT`,
`HTTP(S)_BIND`, `TTL_VERSION`, `SESSION_IDLE_HOURS`, `SESSION_MAX_DAYS`, `MEDIA_MAX_MB` (100), `HISTORY_PER_CHAT` (100,
max 2000), `RECONCILE_MINUTES` (10), `SCREEN`, `LOG_LEVEL`, `TRUST_PROXY`, `TZ`. Multi-user: `CONTROL_SECRET` (app ↔
chromium; `VNC_PASSWORD` is the fallback), `MAX_USERS` (10), `EXTRA_PORTS` (8101-8110), `EXTRA_BIND` (127.0.0.1),
`APP_MEM_LIMIT`, `CHROMIUM_MEM_LIMIT`, `CHROMIUM_SHM`. TikTok: `TT_REQUEST_GAP_MS` (1500), `TT_ENABLED` (tests),
`TT_WEB_ORIGIN` (only the fake end-to-end test changes it; a startup warning is logged), `TT_DOM_SELECTORS` (extra CSS
selectors as JSON, extending `server/src/tt/dom.ts` and `server/src/tt/feedAgent.ts`). Per worker (set by the supervisor): `SOCKET_PATH`,
`INTERNAL_TOKEN`, `TENANT_ID`, `CHROMIUM_URL`, `CHROMIUM_INSTANCE`, `CHROMIUM_TOKEN`.

## 10. Testing

* `server` (vitest, 205 tests): crypto, auth flows, multi-user (claim, reset, isolation, ports, supervisor), gateway
  hardening; `tt/frames.test.ts` (protobuf walk, JSON recovery, bounds, IM URL/socket detection);
  `tt/mapper.test.ts` (TikTok answer shapes, content JSON, stickers/media, junk rejection, DOM rows, stable ids);
  `tt/ingest.test.ts` (encrypted storage with no plaintext in the file, DOM/network merge, album parts, idempotency,
  anti-delete with its 60 s rule, reactions, own messages); `tt/im/` (wire codec, message shapes, engine import and
  catch-up); `tt/feedApi.test.ts` (the API feed and its comments); `tt/stories.test.ts` (tray/batch parsers over the
  live shapes, a photo story, an item without media, the delay bounds, stored-once, the retention sweep deleting story
  and file, the encrypted identity, a manual check while the schedule is off); `tt/items.test.ts` (the live
  `item/detail` shape, a photo post, a gone post, the media routes, caching) and `api/messageType.test.ts` (the stored
  type → `MessageType` translation and the share card of a shared post).
* `web` (16 tests): vitest for the text renderer, the Opus/OGG recorder and the TikTok link reader (`lib/ttLinks`),
  plus `pages/storiesCss.test.ts` —
  every `story-*`/`page-*` class the markup uses has a rule in `styles.css` and every `story-*` rule is used by
  markup (a renamed class in a ported page is invisible to the type-check and the build); typecheck, production
  build.
* `chromium/manager`: `CGO_ENABLED=0 go test ./...` (tokens shared with `supervisor/tokens.ts`, route allowlist, VNC
  tunnel), also run in the image build.
* `scripts/dev/dom-check.mts` (dev, needs a Chromium): the page agent against the fake TikTok, with and without
  `data-e2e` attributes — conversation list, message rows, own-message detection, photo/video rows, opening by name,
  composer, send, file attach, the watcher's capture of IM answers, and the feed agent (item fields, stats parsing,
  next/previous, like, comments with a reply, posting a comment).
* `scripts/dev/service-check.mts` (dev, needs a Chromium): the **real** `TtService` against the fake TikTok with a real
  encrypted database — ready state, three conversations imported, decrypted bodies, sending, a message arriving as a
  protobuf frame, an unsent message flagged by a re-check, and the feed (open, next/previous, un-like, comments,
  posting, video streaming) — then that the messages tab still logs afterwards.
* `scripts/smoke.sh`: the containers — TLS (and no SNI), headers, cookies, CSRF/Origin, signup, the real tiktok.com
  login page in the locked-down Chromium (state `login`), VNC handshake, no app egress, the Chromium sandbox, the admin
  API, a created user, `/internal` unreachable from outside, one unix user per process.
* **Live checks are done against the owner's own account** (CT 124) by running the deployed code inside the app
  container against the real tab: the IM protocol, the web API (feed, comments, stories), the page selectors and the
  media path. `docs/tiktok-notes.md` has the endpoint shapes and the probe procedure.
* Known failing harness check: `service-check.mts` "media rows are queued for download" reports `media_status` `none`
  after the IM rewrite (media is fetched by the engine for private photos and by the queue for the rest); re-check it
  when the media path is next touched.

## 11. Deployment & operations

* **Images:** CI (`.github/workflows/ci.yml`) runs the tests, then builds and publishes
  `ghcr.io/revocx35/tiktok_logger-{app,chromium,caddy}` (`latest`, `x.y.z`, `sha-…`) on pushes to `main` and `v*` tags.
* **Topologies:** (a) from source: `docker-compose.yml` builds the images; (b) prebuilt: `deploy/docker-compose.yml`
  plus `seccomp-chromium.json` and `.env`; (c) either in HTTP mode behind the user's TLS proxy (`setup.sh --http-only`);
  (d) an optional `docker-compose.override.yml` binds the volumes to a dedicated filesystem.
* **Update:** `docker compose pull && docker compose up -d` (prebuilt) or `git pull && docker compose up -d --build`.
  The TikTok login survives restarts (it lives in the Chromium profile). Restarting only `app` does not touch Chromium:
  `docker compose up -d --no-deps app`.
* **Backups:** `app_data` + `app_users` (encrypted; useless without the password or recovery key), `chromium_profile`
  (the live TikTok logins — treat it as a credential), and the system database inside `app_users`.
* **When TikTok changes break something:** run Settings → Diagnostics. If conversation rows or the message list stop
  matching, add selectors in `TT_DOM_SELECTORS` (no rebuild). If the network side stops decoding, frames are read
  structurally (they degrade rather than crash) and the DOM path keeps logging; `docs/tiktok-notes.md` describes how to
  capture a sample and what to look at.
* **Owner's deployment (2026-10):** prebuilt images in an unprivileged Proxmox LXC, HTTP mode behind Nginx Proxy Manager
  (`TRUST_PROXY=2`). Chromium's sandbox works in an unprivileged LXC with `nesting=1`.
