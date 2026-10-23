# DEVLOG — construction notes

## 2026-10-23 — v1.12.1: photo stories were dropped by the parser (so only video stories were logged)

Owner: "the story logging half works some are logged but some arent".

Read-only probe of the live account: the tray listed four authors, the batch answer carried three stories (two videos,
one photo), and the database held **one** — the photo story's group parsed to zero items while
`markStoryUserCaptured` still recorded its `LastStoryCreatedAt`, which is exactly what "half works" looks like.

The cause was one field's shape:

```json
{"id":"7699530832234433799","imagePost":{"images":[{"imageWidth":1440,"imageHeight":2560,
  "imageURL":{"urlList":["https://p16-common-sign.tiktokcdn.com/…jpeg","https://p19-…"]}}],"cover":{…},"shareCover":{…}}}
```

`bestImage()` did `str(img.imageURL)`, so an **object** produced nothing, `parseBatch` answered "no media link" and the
item was skipped without a word. The unit test used the string shape (`imageURL: 'https://…'`), which is why it passed.

Fix: `imageUrl()` accepts a string, `{urlList: [...]}` or `{url_list: [...]}`, the widest image wins, `displayImage[]`
(the older shape) still works, and `imagePost.cover` is the last resort so a photo story is never dropped for a missing
gallery link. The test fixture is now the live shape (plus the legacy one and a cover-only case).

Same pass: the `stories checked` log line now carries `perAuthor` (id, item count, `v`/`i` per item type), so the next
"story X is missing" can be answered from the log — was the author in the bar, what did the batch answer, was the item
a photo — instead of another round of probing.

Proven against the live answer, without writing anything: the same payload that parsed 2 of 3 items now parses 3 of 3
(`something_dprk` video, `yoruk1032` video, `farkedersekahrolim10` **image** with a CDN link).

## 2026-10-23 — v1.12.0: likes go through TikTok's control again (the digg API is 403 "Argus TLB")

Owner: "liking dosent work it says tiktok refused with http 403".

Reproduced against the live tab with the deployed modules (`WebApi` over the messages page), and TikTok said exactly what
was wrong:

```
POST /api/commit/item/digg/?…            -> 403  Web SDK blocked by Argus TLB Plugin
POST /api/commit/item/digg/?aweme_id=…   -> 403  (same, and with item_id / without type / without from_page)
```

The `type=1|0` digg call reads like any other `/api/…` request, but TikTok's anti-bot SDK (Argus / "TLB", i.e.
**ticket guard**) only signs the requests **it** makes: a CDP capture of a real click showed the headers
`tt-ticket-guard-client-data`, `tt-ticket-guard-public-key`, `tt-ticket-guard-version: 2`,
`tt-ticket-guard-web-version: 1`, `tt-ticket-guard-iteration-version: 0` and `tt-csrf-token` (from the cookie), and the
same request answered `200 {"status_code":0,"is_digg":0}`. `web/api.ts` deliberately does not recreate those (signing
TikTok's requests is the one thing this project never does), so a like must be a **click**.

What a click needs, measured on the live page:

* the control is `[data-e2e="like-icon"]` on the video's own page (and on `/foryou`); `button[data-e2e="likes"]` is a
  0×0 hidden element elsewhere on the page — selecting it throws "Node is either not clickable";
* `aria-pressed` is the state (`false` → `true` on a like), and the button's text / `[data-e2e="like-count"]` is the
  count, so the result can be read back instead of assumed;
* `el.click()` from page context is enough (unlike the DM composer, which needs trusted input): pressing it flipped
  `aria-pressed`, moved the count 557 → 558 → 557 and produced `digg 200` both ways;
* `/@author/video/<id>` is the deterministic place to click: the feed tab's own `/foryou` list is a *different* order
  from our API catalogue, so an item further ahead is not reachable by scrolling (`FeedAgent.ensureItem` answers
  `not_rendered`, `pin` then answers 409).

Fix: `ApiFeed.like` delegates to `FeedService.likeOnVideo` — use the page's rendered list when it has the item, otherwise
`page.goto('/@author/video/<id>')` (a new document, so `agent.install()` runs again), then the existing
`FeedAgent.like` + `aria-pressed` poll. `videoPageUrl()` builds that URL. The digg call is gone, so nothing can silently
answer 403 again. `feedApi.test.ts` pins delegation, "already so = no click", "a click TikTok ignored is reported as it
is", and error mapping (409 passes through, anything else is the route's `like` error).

The same probe showed comments are **not** blocked (`/api/comment/publish/` with a bogus id → 200 + `status_code`), so
they stay on the web API; only the digg endpoint carries the ticket-guard requirement.

## 2026-10-22 — v1.11.1: the card's thumb is the author's avatar (that was the drop)

v1.11.0 sent the right message type (8, Video) and still got the link fallback. So the payload itself was next, and the
answer came from TikTok's own request bytes. Its web client sends that card over its **WebSocket** (not HTTP), so a
`fetch`/`XMLHttpRequest` hook saw nothing — the capture that worked was `Network.webSocketFrameSent` on the CDP session
while driving the real "Share to" panel (share icon → recipient → Send), then decoding the protobuf frame by hand:

```
frame  1=10004  2=<ms>  8=<envelope>  8.15=<ticket-guard/metadata>
body (8.8.100): 1=convId  2=1  3=<sourceId>  4=<content JSON>  5=tags  6=8  7="deprecated"  8=clientMessageId
content: {"aweType":800,"itemId":…,"uid":…,"secUID":…,
          "content_thumb":{"url_list":[<AUTHOR AVATAR 100×100>],"uri":<avatar>},
          "content_name":<nickname>,
          "cover_url":{"url_list":[<video cover>],"uri":<cover>},"cover_width":576,"cover_height":1024}
```

Everything matched what we already sent **except `content_thumb`**: TikTok puts the *author's avatar* there; we put the
video's cover. Proven with one live send of each body into a real chat and a conversation read-back: the avatar body is
stored (the card appears and comes back from `get_by_conversation` with `aweType":800` and the item id), the cover body
is accepted with status 0 and never stored.

Fix: `ApiFeed.share` and `FeedService.share` pass `thumb: {urls: [author avatar]}` (`avatarMedium`/`avatarThumb` from the
item list), falling back to the cover only when TikTok gave no avatar. `tt/feedApi.test.ts` pins it.

How the capture was made, for next time: a `fetch`/XHR hook is not enough for the IM SDK — it writes to its socket.
`page.createCDPSession()` + `Network.enable` + `Network.webSocketFrameSent` records the frames; each is protobuf,
first field = command (10004 = send), and the card JSON is plain text inside field 8.8.100.4.

## 2026-10-22 — v1.11.0: shared posts go out as Video messages

Owner: "can you try implement it", after asking whether the other side can see our share as a card at all.

v1.9.0–1.9.5 built the card body field by field and TikTok still answered status 0 and stored nothing. The answer was
in TikTok's **own web client**: its DM share dialog builds

```js
sendMessage({ convId, uid, relation,
  type: m.Go.Video /* 8; Text = 7, Story = 1025 */,
  content: { aweType: 800, itemId, uid, secUID, content_thumb: { url_list: [cover], uri: cover },
             content_name, cover_url: { url_list: [cover], uri: cover }, cover_width, cover_height },
  hasConversation })
```

and the receiving side renders a card from exactly that (`case s.Go.Video` → `content_name`, `content_thumb`,
`itemId`).

* **The envelope's field 6 is the message type**, and `buildSendRequest` hardcoded `7` (Text) for everything — a
  "text message whose content is a card". The reference bridge corroborates the field: it sets `Reserved_6 = 1802`
  together with `message_subtype = "private_image"` for a private image. Shares now use `MESSAGE_TYPE_VIDEO` (8);
  text and replies stay 7.
* The content body now matches the official one: `secUID` (camelCase, was `sec_uid`), the cover's `uri` **is the cover
  URL** (was `''`), both covers carry `{uri, url_list}`, and the extra `content_title` is gone.
* `confirmShare` and the link fallback stay exactly as they were: if TikTok still drops it, the canonical link goes out
  instead and the log says so.

Tests: `tt/im/proto.test.ts` pins the message type (8 for a share, 7 for text and replies) and the whole card body
field for field; 232 server tests.

## 2026-10-22 — v1.10.1: the chat card served no bytes

Found by running the deployed `dist/tt/items.js` against the live tab right after v1.10.0 shipped: the post resolved
correctly (desc, author, stats, duration, no CDN link in the DTO, a bogus id answered 404) but `bytes()` returned
`null` for both the video and the cover.

`FeedMedia.ref(url)` answers the **route path** `/api/feed/media/<id>`, while `get()`/`cached()` are keyed by
`refOf(url)` — so a ref stored from `ref()` never hit the byte cache and every fetch was a miss. `TtItems` now
registers the link and keeps `refOf(url)` as the id (`register()`).

The unit tests missed it because their downloader was `null`, so nothing ever walked the cache. `tt/items.test.ts` now
has a case with a page-downloader stand-in: it asserts the bytes come back (an `ftyp` at offset 4), that the CDN URL
was asked for exactly once and that a second read is a cache hit — reverting `register()` makes it fail.

Lesson for the next endpoint that reuses `FeedMedia`: the path it returns is for the *feed's* route; the cache id is
`refOf(url)`.

## 2026-10-22 — v1.10.0: a shared video is a video, not a link

Owner: "when i send a video it only is a link … also when i open a chat the video links are only shown as links i dont
see videos".

Two separate things were wrong, and the first one was a plain bug:

* **Every shared post was invisible.** TikTok's IM protocol sends a shared video as `aweType` 800 and the row is stored
  with `type = 'shared_post'`; `api/view.ts` cast that straight into `MessageType` (`row.type as MessageType`). The web
  UI's render switch matched nothing, `share` was always `null`, and the message rendered as its title (or as nothing).
  In the live log that is **1 873 rows** — the most common message type in the owner's chats. `api/messageType.ts` now
  translates the stored types (`shared_post` → `share`, `media` → `video`/`voice`/`image` by the stored mime,
  `unsupported` → `unknown`) and builds the `ShareInfo` from the IM meta (`itemId`, canonical URL, title). The frame
  path had the same hole: `tt/mapper.ts` read `awe` from `content.aweType`, but `content` is a *JSON string* there, and
  `TYPE_BY_AWE` had no `800` — `contentObject()` and the `800` entry fix both, and the post id/url are kept in meta.
* **Nothing resolved a post**, so there was nothing to play. `tt/items.ts` calls TikTok's own
  `GET /api/item/detail/?itemId=…` from the messages tab (probed live the same day; `aweme_id` is rejected with
  `illegal itemID`, an unknown post answers 200 + `statusCode 10204` + no `itemStruct`), caches the answer 10 minutes,
  and downloads the video/cover **through the page** (the CDN needs the tab's cookies) into the feed's kind of
  byte-bounded cache. `/api/items/:id` + `/api/items/:id/media/{video,cover}` serve it with `Content-Length`, Range
  (206) and an ETag — a phone will not play a video that cannot be ranged — and the signed CDN link never reaches the
  browser. `api/ranged.ts` is now the one ranged sender (the feed's route uses it too).

The web card (`components/TikTokCard.tsx`) appears when a message has `share.itemId` **or** its text holds a TikTok
video link (`lib/ttLinks.ts` — the shape the send fallback produces), which is why the fallback link now plays too. It
resolves only when it scrolls into view (`IntersectionObserver`, 200 px margin) and dedupes requests per post per
session: a chat can hold hundreds of shares and every miss is a request through the tab. It shows the cover, author,
duration and like/play counts; clicking swaps in the ranged `<video>`; a post that cannot be resolved (deleted,
private, region-locked) degrades to a link out. The bubble's title is no longer printed twice under the card, and
`width: min(300px, 100%)` on the card was replaced with `width: 300px; max-width: 100%` — the `min()`/percentage form
made Chromium give the bubble an 85 %-wide max-content, so every card message became a balloon.

**What cannot be fixed from here:** TikTok still drops the shared-post card the app sends (v1.9.4/1.9.5 proved it by
reading the conversation back), so in TikTok's own clients the recipient sees the canonical link. What changed is this
app's view: the post is a card you can play. Short `vm.tiktok.com` links carry no id and are not followed.

Tests: `api/messageType.test.ts` (8 — the type translation, the card from meta/URL/TikTok's own fields, the id reader),
`tt/items.test.ts` (7 — the live `item/detail` shape pruned from the probe, a photo post, a gone post, the media URLs,
caching, a malformed id, TikTok not connected), a `mapMessage` case for the shared-post frame, `web/src/lib/ttLinks.test.ts`
(4). Server 230, web 16, typecheck + build.

## 2026-10-22 — v1.9.6: the Stories page rendered half unstyled

Owner: "the ui of the stories page is broken".

The page was ported from insta_logger with its class names changed, and `styles.css` kept the parent project's:
`story-viewer-body` vs `story-stage`, `story-tile-meta` vs `story-meta`, `story-tile-badge`, `story-tile-pending`,
`story-viewer-head/foot/close/side/missing` and `story-initial` had **no rule at all**, `.story-author.active` did not
match `.on`, and `.page-actions` / `.page-more` did not exist. What the owner saw: the full-screen viewer had no stage
(the photo sat at its natural size in the middle of the overlay, the close button was a bare browser button at the top,
the ← / → were empty 16 px boxes), the avatars rendered at their natural 200px+ size over the account row and the
first tiles, the tiles had no @name/time caption, and `next ${when(nextCheckAt)}` printed "next 0 h ago" for a time in
the future.

Read from the deployed artifact first, not from the repo: the app image's JS bundle contains `story-viewer-body` while
its CSS only has `story-stage` — the mismatch was live, not a stale checkout. Then the real component + the real
`styles.css` were rendered in a local Chromium against a mock `/api/stories*` (desktop 1280×900 and phone 390×844,
grid and viewer) to see and measure it before and after (`.story-viewer-body` was `position: static`, 16×17).

* The stylesheet now uses the markup's names; the viewer stage is `min(100vw − 12px, 92vh × 9/16)` wide so a phone
  never gets a stage wider than the screen (the old height-first box overflowed sideways at 390 px).
* Avatars are 58×58 at `top/left: 3px` inside the 64 px gradient ring — fixed sizes, because a replaced element with
  an auto width keeps its intrinsic size and drops the over-constrained `right`, which is how a 360×640 avatar became
  a 364×644 ellipse over the row.
* Story counts are the badge `.story-count`; the header is `page-head row between wrap`, so "Check now" sits on the
  title row on a phone as well; the viewer gained a real close button, footer ("2 / 12 · expires in 57 min"), disabled
  arrows at the ends, and text shadows so white text stays readable over a bright photo.
* `until()` for future times: "next in 18 min", "expires in 57 min" (was "next 0 h ago", "-1 h ago").
* Settings → Logging's story picker got its row avatars sized (28 px) — same bug, the `img` had no rule.
* Dead rules removed (`.story-stage`, `.story-meta`, `.story-badge`, `.story-missing`, `.story-nav`, `.story-head`,
  `.story-ring.all`, `.story-picker-list`, `.story-pick-name`).

New guard `web/src/pages/storiesCss.test.ts` (node env, reads the sources): every `story-*`/`page-*` class in
`className=` must have a rule, and every `story-*` rule must be used by some markup. Against the previous
`styles.css` it reports exactly the 12 classes that were missing — a type-check and a build cannot see this, which is
how it shipped.

Tests: web 12 (2 new), typecheck + build; server 214 unchanged.

## 2026-10-22 — v1.9.0: reactions, replies and video cards through the IM protocol

Owner: "add reactions support … look at TikTok's message UI and get feature parity … sending videos shows up as a link,
not a TikTok video … use the new architecture, not the old page."

The protocol envelope already understood these messages when *reading* (`aweType` 703 replies, 800 shared posts,
reaction summaries in field 15); sending them needed the request shapes, taken from the reference implementation's
captured traffic (`/root/ref/matrix-tiktok` on CT 105, `proto/tiktok/im/v1/im.proto`):

* **Reactions** — `POST /v1/message/set_property`, envelope **705 / 10008**, payload 705 → `{body, "deprecated"}`,
  body = conversation id, `action_flag` 1, source id, the message id, a fresh client uuid and one mutation
  `{action: 0|1, "e:<emoji>", selfUserId}`. The same ticket-guard + DPoP headers as a send. The reaction is applied
  locally at once (the UI answers immediately) and confirmed by the socket or the next catch-up.
* **Replies** — the content becomes `{"aweType":703,"text":…}` and `SendMessageReplyAttachment` rides field 11:
  `{referenced id, reference JSON, the same id, parent cursor}`. The reference JSON carries the quoted content plus
  `refmsg_uid` / `refmsg_sec_uid`, which is what TikTok renders the quote from.
* **Video cards** — the content becomes `{"aweType":800,"itemId":…,"uid":…,"sec_uid":…,"content_title":…,
  "cover_url":…}`. The feed item list already carries `author.id` and `author.secUid`, so `FeedCatalog` keeps them and
  `POST /api/feed/:id/share {chatId}` sends the card. The web's "Send" now uses that route instead of mailing the URL,
  which is why a shared video showed up as a plain link.

One live discovery, after the first deploy: the share request answered 200 with status 0 and then **nothing appeared** —
TikTok's own cards carry `cover_url` **and** `content_thumb` as objects (`{uri, url_list}`), plus `content_name`,
`content_title`, `cover_width` and `cover_height` — a body with fewer fields is accepted with status 0 and then never
stored. All of them are sent now (`ShareArgs`). The builder now sends the object form (and the same was true for the
reaction: `action_flag` must be **2 in a group**, 1 in a direct chat — with 1 a group answered status 500).

Even with the complete body the card was still not stored (checked through the all-conversations combo feed: no shared
post in the last 30 minutes), so the send now **verifies what it sent**: the conversation's newest rows are read for the
message id or for an `aweType: 800` body carrying the item, and when TikTok did not keep it the canonical link is sent
as text instead, with a warning in the log. A share that silently disappears is worse than a link; if TikTok starts
accepting the card again it is used as-is.

Remaining parity gaps, deliberately: media *uploads* still go through the page's file input (the protocol needs the
private-image/VOD upload dance), unsend/edit are still reported `not_supported`, and typing indicators are not sent.

Tests: 6 new in `im/proto.test.ts` (the reaction envelope and both mutations, reply content + field 11, the shared-post
content, the empty-quote fallback); 211 server tests, 10 web.

## 2026-10-22 — v1.8.0: story logging (stories section)

TikTok's stories are 24-hour posts; insta_logger logs Instagram's the same way, so this is the same shape: a periodic
read of the stories bar (`GET /api/story/user_list/?count=10&cursor=…` — the endpoint needs `cursor` even on the first
page, without it TikTok answers 400 `missing required fields…`), then one batch call per 20 authors
(`GET /api/story/batch/item_list/?authorIds=a,b,c`) whose answer carries each item's `video.playAddr`, `story.ExpiredAt`
and `createTime` (seconds). Photo stories have `imagePost.images[]` and no play address; the biggest candidate wins.

* an item is stored once (its id is the primary key) and its media is downloaded through the page into the same
  encrypted media files as a message's, served by the existing `/api/media/:id` route (range + decryption included);
* every pass sweeps stories older than `storyRetentionDays` (and their files), so the log cannot grow without bound;
* the interval is `storyIntervalMinutes` ± a quarter of it (random), the first pass runs three minutes after start;
* off by default, `storySelected` limits whose stories are kept (empty = everyone in the bar), and nothing is marked as
  seen — the tray read is all it does;
* avatars of the authors are fetched a few per pass (they are content, so they are encrypted too).

Tests: `tt/stories.test.ts` (9) — tray and batch parsers over the live shapes, a photo story, an item without media,
the delay bounds, "stored once", the retention sweep deleting story and file, and the identity staying encrypted.

## 2026-10-22 — v1.7.1: "refused code 100", names and pictures, background share

* **Send reported "TikTok refused (code 100)" although the message was sent.** The send answer's field 1 echoes the request
  *type* (100); the status is field 3. `parseSend` read field 1. The message did go out; the catch-up stored it a few seconds later.
* **No profile pictures and no names for group members**: the app never fetched them (v1.0–1.6 relied on page reading). `ImEngine.refreshPeople`
  now loads the profile (`/tiktok/v1/im/user/profile/`: nickname, @name, picture) of every peer and every stored sender, names
  chats from their peer, and `syncAvatars` downloads pictures (a few per pass; failures retried after a day). A stranger who
  speaks in a group is named within ~2 s (a queue, not a single slot — an earlier version dropped ids arriving while a lookup waited).
* **Stretched pictures in the share list**: `.feed-chat-row span {flex:1}` also hit the avatar `<span>`.
* **Share is background**: the menu closes at once, a note says "Sending to X…", then "Sent to X." or the error.

## 2026-10-22 — v1.7.0: the feed, comments and likes through TikTok's web API (no feed page)

Same idea as the IM protocol, for `www.tiktok.com/api/...`: TikTok's page hooks `fetch` and signs any request that carries the
browser/device parameters its own requests carry (`X-Bogus`, `X-Gnarly`, `X-Dynosaur`, `msToken`, CSRF, ticket guard). Measured
live from the *messages* tab: with the full parameter set (`web/api.ts`) the comment list, the feed list and ranged video fetches all
answer; with fewer parameters, or with `msToken` added by hand, TikTok answers **200 with an empty body** (treat that as a refusal).

* Feed: `POST /api/recommend/item_list/` (6 videos, each with its signed `playAddr`) fills the catalog; a swipe is an index move;
  the list is topped up when fewer than 6 follow. Photo posts (no `playAddr`) are skipped. Videos are downloaded in the messages tab.
* Comments: `GET /api/comment/list/` (+ inline replies), `POST /api/comment/publish/` (text in the query, empty body).
* Likes: `POST /api/commit/item/digg/` (`type=1|0`). The publish/digg request shapes were captured by intercepting the page's own
  requests and aborting them (`Fetch.failRequest`), so nothing was posted or liked. **Posting a comment and liking are not yet
  verified end to end**; the page-driving feed (v1.5) remains as a fallback for reads, never for writes (a lost answer must not
  be repeated another way).

## 2026-10-22 — v1.6.1: ~800 empty "chats" from the old capture are hidden

Found on the deployment after v1.6.0: 808 chats, 17 with messages. The schema-less reader of v1.0–1.5 made a chat of any object
with an id in TikTok's answers (user ids, 19 digits). `ImEngine.pruneEmptyChats` soft-removes chats with no messages that TikTok
does not list; the chat list hides removed chats without messages.

## 2026-10-22 — v1.6.0: the IM protocol in the tab (no more reading the page)

Owner: "just do what insta_logger does". insta_logger runs Instagram's own requests inside the tab; this is the TikTok
equivalent, built from `/root/ref/matrix-tiktok` and **checked live** with `scripts/dev/im-probe.mts` (read-only, prints
structure only):

* The web client's IM API is protobuf on `im-api-sg.tiktok.com`. A `fetch` from the tab with `credentials:'include'`, the
  `Accept` + `Content-Type: application/x-protobuf` headers and **no query string** works (an extra `Cache-Control`
  header made the CORS preflight fail → "Failed to fetch"). Device id = `wid` from the page's rehydration JSON, token = the
  `msToken` cookie.
* `get_by_user_init` only ever returns the ten newest chats and ignores cursor/limit. The current web client uses
  **`get_by_user_combo`** (type 204): an *ascending feed of every message of every conversation after a µs cursor*, 50
  rows/page, two lanes (0 = one-to-one, 1 = groups), `hasMore` + next cursor. That is the catch-up primitive: poll it every
  5 s from the stored cursor (rewound 90 s; ingest is idempotent).
* `get_by_conversation` pages a chat's history; an unsent message stays there as a placeholder tagged `s:is_recalled`, so
  unsends are *read*, not inferred from what vanished from the DOM (the old "missing" heuristic produced false positives:
  the same fake-TikTok failure still shows on the fallback path).
* The socket (`im-ws-sg…/ws/v2`) frames are `__lz4`-compressed protobuf: the old schema-less reader could not see them, so
  live capture never worked and everything came from DOM polling. Now `parseSocketFrame` (LZ4 block + typed events: chat,
  recall, reaction, read receipt, typing).
* Ids in JSON bodies are 19-digit numbers: `s:property_modify` is read with a regex, never `JSON.parse`d into a number.
* Sending: `/v1/message/send` with `ztca-dpop` (ES256 DPoP proof) + `tt-ticket-guard-*` for a fresh P-256 key per send, as
  the reference does. **Not verified against a real send yet** (needs a recipient the owner names).
* Private photos are AES-256-GCM blobs (`nonce|ciphertext|tag`, key in the message): decrypted in memory, stored by us.

Fallback: when the probe fails (or on a non-tiktok.com origin, i.e. the test double) the page-driving path of v1.5 runs
unchanged. Media uploads (photos/videos/voice) are still sent through the page. Page-read rows already in the database are
adopted by the protocol rows (same text, ±6 min) and a false "missing" is cleared when the server shows the message.

## 2026-10-22 — v1.5.1: comments (stale panel, and Post stayed disabled)

* The comment panel's close control is `[data-key-interaction="comment_close"] button` (`aria-label="exit"`); the old
  selector (`[aria-label*=close]`) matched nothing, so the panel stayed open and the next video "opened" with the previous
  video's rows. `closeComments` now clicks the real button and `comments()`/`comment()` close a left-over panel first.
* The comment box is Draft.js like the messages composer: `execCommand('insertText')` fills the DOM but TikTok's Post button
  stays `disabled`. Posting now types with real key events (puppeteer) and clicks Post once it is enabled. Header count
  ("Comments 12") equals the item's comment stat — a handy check that the panel belongs to the video.

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
