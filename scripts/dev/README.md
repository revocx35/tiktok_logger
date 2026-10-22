# Development helpers

Things that cannot live in `npm test` (they need a browser) or in `scripts/smoke.sh` (they need nothing but Node and a
Chromium). Run them from `server/`, because that is where the dependencies are:

```bash
cd server
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npx tsx ../scripts/dev/dom-check.mts
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npx tsx ../scripts/dev/service-check.mts
```

If you have no Chrome, install the shared libraries and use any recent build; the checks only need headless Chromium:
`chrome --headless` works, `--no-sandbox` is used *in the test launcher only* (the shipped images keep the sandbox).

## fake-tiktok.mts

A test double for TikTok's messages page and IM endpoints: three conversations, text, a photo, a video, a composer,
an `<input type=file>`, and JSON answers under `/api/im/` (so the Watcher has something real to capture). `--plain`
serves the same page **without** `data-e2e` attributes, to exercise the structural heuristics in `dom.ts`.

```bash
cd server && npx tsx ../scripts/dev/fake-tiktok.mts --port 8099   # then open http://127.0.0.1:8099/messages
```

`startFakeTikTok()` is also imported by both checks; `fake.receive(conversationId, text)` appends a message as if the
peer sent it.

## dom-check.mts

The page agent (`tt/dom.ts`) and the Watcher against the fake, in both selector modes: conversation list, message rows,
own-message detection, photo/video rows, opening a conversation by name, filling and sending, attaching a file, and the
capture of IM answers. ~40 checks, one line each.

## service-check.mts

The real `TtService` end to end against the fake, with a real encrypted database in a temporary directory: connect →
import three conversations → decrypted bodies → media queued → send → a message arriving as a protobuf frame → an
unsent message flagged by a re-check. It uses the `connectHook` seam in `TtService` to hand the service a local browser
instead of the chromium manager.

## ui-shots.mts

Screenshots of the web UI (light, dark, phone) for checking a visual change by eye; needs a Chromium and a running app
with an account. Not used by CI.

## multiuser-e2e.mts

Against a running stack (`BASE=… EXTRA_PORT=… PROJECT=…`): unix users and permissions, one Chromium per user, port
pinning, claim/reset/wipe/delete for real, no cross-tenant file access. See the header of the script.
