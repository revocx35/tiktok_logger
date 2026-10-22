# TikTok notes — what the implementation is based on

Practical notes for the TikTok layer (`server/src/tt/`). Read this before debugging capture or sending, and **update it
after a live check**: it is the only place where the facts behind the code are written down.

## The IM protocol (verified live 2026-10-22)

See DEVLOG v1.6.0 for the details. Endpoints (POST protobuf to `https://im-api-sg.tiktok.com`, no query needed for reads):
`/v2/message/get_by_user_init` (203; ten newest chats), `/v1/message/get_by_user_combo` (204/10074, client version 1.8.3;
the paged all-conversations feed), `/v1/message/get_by_conversation` (301), `/v1/message/send` (100; DPoP + ticket guard),
`/v3/conversation/mark_read` (604). Socket `wss://im-ws-sg.tiktok.com/ws/v2` (binary, `__lz4`). Probe it read-only with
`scripts/dev/im-probe.mts` (bundle with esbuild, run next to the browser; prints structure, never content).

## What is verified, and what is not

| Area | Status |
|---|---|
| Page reading (conversation list, message rows, own-message side, media rows, open-by-name) | verified against `scripts/dev/fake-tiktok.mts` in a real Chromium, **with and without** `data-e2e` attributes (`scripts/dev/dom-check.mts`) |
| Sending (composer fill, send control/Enter, confirmation, file attach through `input[type=file]`) | same |
| The whole service (login detection → import → encrypted storage → sending → a stream frame → unsent detection) | same, `scripts/dev/service-check.mts` |
| Protobuf/JSON decoding, mapping, ingestion | unit-tested (`server/src/tt/*.test.ts`) |
| **Today's real TikTok Web: DOM, IM answers, stream frames, login flow** | **not yet checked live** (needs the owner's account) |

So the structure is proven; the *shapes* TikTok uses today are what the first live check must confirm.

## Facts used by the code

* The web client opens a WebSocket to **`wss://im-ws.tiktok.com/ws/v2`** for real-time messages. (Seen in public
  network recordings of `www.tiktok.com`; the path and host are matched by `watcher.ts`/`frames.isImSocket`.)
* IM HTTP endpoints live on `tiktok.com` (and `tiktokv.*` for the app); the web client's own paths are under
  `/api/im/…`. `frames.isImUrl` accepts any path segment `im|dm|messaging|chat|conversation|thread|mail` on those hosts
  — deliberately broad, because the exact list changes.
* **The web client's message content is JSON inside a protobuf envelope**, the same design Douyin's web client uses: a
  text message's content field is `{"text": "…", "aweType": 700, "is_card": false}`, a sticker has `aweType: 500` and an
  `image_id`/`url`, a voice message is an audio URL list, a share card has no `text`. `frames.readFrame` recovers the
  JSON by walking the envelope structurally; `mapper.messageText` parses it.
* Timestamps arrive in seconds (sometimes ms or µs); `types.toMillis` normalises and rejects implausible values.
* The pages: `tiktok.com/messages` (conversation list + open conversation), `tiktok.com/login` for the login flow.
  Whether a conversation's id appears in the URL depends on the build — `dom.currentThreadId` therefore also uses the
  clicked row and the page's own "selected" marker.
* `data-e2e` attributes are TikTok's own convention (`browse-video-desc` is a known example on video pages). The
  conversation list/message list/composer candidates in `dom.ts` follow it first, then class-name heuristics.
* TikTok's login can show **Arkose FunCaptcha** (`arkoselabs.com`) or a Google reCAPTCHA frame; both hosts are allowed
  in `chromium/policies.json` (with third-party cookies only when the top-level page is tiktok.com — without the
  captcha's cookie a solved captcha is rejected).
* A session from a normal browser consists of `sessionid` (+ `sessionid_ss`/`sid_tt`), the account id in
  `uid_tt`/`uid_tt_ss`/`webapp_uid`/`sid_guard`, and device-ish cookies (`ttwid`, `msToken`, `csrf_token`, `s_v_web_id`).
  `tt/cookies.ts` keeps only the known names and never logs them.

## First live check (do this once, with the owner's account)

1. Log in on the TikTok screen. Watch the app log: `state=login → starting → syncing → ready` should appear.
2. Settings → Diagnostics → **Check what is being read**:
   * `stream frames` > 0 → the IM WebSocket is being captured (good).
   * `IM answers` > 0 and `recent IM paths` lists real paths → the HTTP endpoints are being captured.
   * both 0 → only the DOM path is working; capture is still functional but ids/timestamps stay estimated.
3. Open a chat in the UI: messages should appear within ~3 s (poll). If the list is empty but the conversation has
   messages, **Show the page's structure** and compare with `dom.ts`:
   * find the message list and row elements in the dump, then set e.g.
     `TT_DOM_SELECTORS={"messageList":["[class*=\"DivMessageList\"]"],"messageRow":["[class*=\"DivMessageItem\"]"]}`
     in `.env`, `docker compose up -d --no-app-deps app` (or restart the app),
   * repeat for the composer/send button if sending fails.
4. Send a test message from the UI to a friend (or to yourself from another account) and check that it appears on
   TikTok within a few seconds. The UI's confirmation uses the sent row, so a failure shows as "TikTok did not accept
   the message".
5. Ask the other side to unsend it: after the next re-check (Settings → re-check interval, default 10 min) the message
   must still be readable here, marked "Unsent"/"Gone from TikTok".
6. Send a photo: it should appear on TikTok and be stored locally immediately (we keep our own uploaded bytes).
7. Note anything that differed (shapes, selectors, timing) **in this file**.

## If TikTok changes something

* **Messages stop appearing, state is ready**: the DOM path broke. Take the structure dump from Diagnostics, add
  candidates in `dom.ts` (and/or `TT_DOM_SELECTORS` for the running instance), and re-run
  `scripts/dev/dom-check.mts` after updating the fake to look like the new page.
* **No ids / no exact times**: the network side broke (new endpoint, new envelope). Frames are decoded structurally, so
  a new envelope usually still yields JSON; if it does not, capture a sample (below) and extend `frames.ts`/`mapper.ts`.
* **Sending fails**: the composer/send control changed. Check the structure dump around the composer; the agent falls
  back to Enter, so a failure usually means the composer itself was not found.
* **Login loops**: TikTok's bot checks. Confirm `TZ` matches the account's region, that WebGL works
  (`--ignore-gpu-blocklist` + Mesa is in the image), that no debugger is attached while logged out (the app does not
  attach), and use the pasted-session login as the reliable path.

## Capturing a sample (when a decoder needs work)

The Watcher counts what it sees and keeps the last 20 IM paths (`GET /api/tt/diagnostics`). To look at an actual frame:

```bash
# inside the chromium container, the DevTools relay is token-checked; the app is the normal way in.
# Simplest: add a temporary log in watcher.ts `onFrame` (base64 + length), rebuild, reproduce, then remove it.
```

Never paste real message content, session cookies or `msToken` values into an issue, and never commit a capture.

## Scope reminders

* No request signing, ever: if something needs a signed call, drive the page instead.
* No mobile-app API (`/v1/message/send` on `api*.tiktokv.com` and friends): it is a different signed world and it would
  put an app-shaped fingerprint on the account from a datacenter IP.
* Opening a conversation marks it read on TikTok. The import and the re-check open conversations by design; do not add
  extra opening (no "read every chat every minute" features).
