# tiktok_logger

A self-hosted TikTok **direct-message logger**. It keeps a complete, encrypted copy of your TikTok DMs — text, photos,
videos, voice messages, shared posts — and of messages that were **unsent** afterwards.

It runs TikTok in its own browser on your server (a real Chromium, kept off your phone), reads what that browser sees,
and stores it encrypted on your disk. You can also send messages from the web UI as your account.

* **Anti-delete:** a message that is removed on TikTok stays readable here, marked "Unsent"/"Gone from TikTok".
* **Encrypted at rest:** message text, names and media are encrypted with your password (and your recovery key). The
  server cannot read them while you are logged out, and neither can anyone who steals the disk.
* **Multi-user:** the admin creates accounts; each user has their own TikTok login, keys, database and browser. Nobody
  sees anybody else's data — not even the admin.
* **Repeatable:** Docker Compose, three containers, no TikTok password stored anywhere (the login lives in the browser
  profile, like a normal browser session).

> **Not affiliated with TikTok.** Logging messages you receive is your own responsibility, and so is how the account is
> used: TikTok's terms do not allow automated browsers, and an account can be restricted for it. Recording conversations
> may require the other person's consent where you live.

## What it does

| | |
|---|---|
| Reads | conversations and messages (text, photos, videos, voice, stickers, shared posts), sender names, timestamps |
| Keeps | everything encrypted on your server, including media files, in an SQLite database + media folder |
| Notices | unsent messages, TikTok's "message deleted" lines, edited/deleted media |
| Sends | text, photos, videos, audio (from the composer), with "seen" only when you reply (configurable) |
| Shows | conversation list, chat view with search, an "Unsent" feed, one ZIP per selection of media |
| Users | admin + up to `MAX_USERS`, each with their own TikTok account, keys and browser; separate ports possible |
| Logs in | on the built-in screen (noVNC), or by pasting a session from your own browser |
| Does not | calls, the feed/For You, posting videos, comments, or several TikTok accounts in one user |

## Requirements

* A Linux host with Docker and Docker Compose v2 (about 2 GB RAM per active user; 4 GB is comfortable for one).
* Internet access from the *chromium* container to `tiktok.com` and its CDNs. The app container has no internet on
  purpose.
* An unprivileged LXC/VM works; for a Proxmox LXC, enable `nesting=1` so Chromium's sandbox can run.

## Quick start (prebuilt images)

```bash
mkdir tiktok_logger && cd tiktok_logger
curl -fsSLO https://raw.githubusercontent.com/revocx35/tiktok_logger/main/deploy/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/revocx35/tiktok_logger/main/chromium/seccomp-chromium.json
curl -fsSLO https://raw.githubusercontent.com/revocx35/tiktok_logger/main/scripts/setup.sh
chmod +x setup.sh && ./setup.sh          # writes .env with secrets; add --http-only behind your own TLS proxy
docker compose up -d
```

Then open the address printed by `setup.sh`, create the first account with the setup token, save the recovery key, and
log in to TikTok on the **TikTok** screen. That is all: messages start arriving.

From source instead:

```bash
git clone https://github.com/revocx35/tiktok_logger.git && cd tiktok_logger
./scripts/setup.sh && docker compose up -d --build
```

### Logging in to TikTok

The browser runs on the server, and you see it in the web UI (*TikTok* in the menu) or in any VNC client. Log in there
normally — TikTok's captcha, e-mail/SMS code, "verify it's you" — everything appears on that screen.

If TikTok keeps refusing the server's browser, use **"Log in with your own browser"** in Settings → TikTok: log in on
your computer, open DevTools → Network, right-click a request to `www.tiktok.com`, *Copy as cURL*, and paste it. Only
TikTok's own cookies are kept, and only in the browser profile.

### Where to put it behind a reverse proxy

Run `./scripts/setup.sh --http-only` and point your proxy (Nginx Proxy Manager, Caddy, Traefik…) at the HTTP port.
Forward `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`, allow WebSockets (the live screen and the event stream need
them), and set `TRUST_PROXY` in `.env` to the number of proxy hops (1 = your proxy only, 2 = a proxy in front of your
proxy). With more than one user you can give each their own port (`EXTRA_PORTS`) and domain.

## How it works (short version)

```
tiktok.com ⇄ chromium container (one real browser per user, VNC screen) ⇄ app (reads the page + its traffic over CDP,
                                                                         encrypts and stores everything)
                                                                        ⇄ your browser (web UI over SSE)
```

The app never signs or replays a TikTok request: TikTok's own client does all of that, and tiktok_logger only reads what
that client shows and receives. Sending works the same way — it fills TikTok's message box and presses send, like a
person would. See `ARCHITECTURE.md` for the long version, the security model and the limits.

## Settings worth knowing

| Setting | Default | What it does |
|---|---|---|
| History per chat | 100 | How far back the first import reads each conversation. |
| Download history media | on | Downloads photos/videos of imported history (not only new ones). |
| Mark chats as read | off | Marks a conversation as seen on TikTok when you open it here. Opening a conversation for the import/re-check does it anyway (TikTok has no other way to read a chat). |
| Refresh the session | every 2 h | Reloads the background tab like a person coming back to it. |
| Re-check for deleted messages | every 10 min | Re-reads the newest conversations and flags messages that are gone. |

## Storage, backup, moving

Two Docker volumes: `tiktok_logger_app_data` (encrypted database + media of the first account and the others' data under
`/users`) and `tiktok_logger_chromium_profile` (the live TikTok logins — **treat it like a password**). Both are what you
back up. Restoring them on a new host keeps everything, including the login. Without your password or the recovery key
the data is unreadable — that is the point, and it also means nobody can help you recover it.

To cap storage, put the volumes on a dedicated, size-capped filesystem (see `docker-compose.override.yml` in the repo).

## Troubleshooting

* **State stays "Log in to TikTok"** — open the TikTok screen: TikTok may be showing a captcha or a "verify it's you"
  page. Answer it there. If the page is blank, use *Restart* in Settings → TikTok.
* **Messages do not appear although the state is ready** — Settings → TikTok → **Diagnostics**: "Check what is being
  read" shows whether frames/answers are arriving; "Show the page's structure" dumps the messages page's structure
  (no text). If TikTok changed its page, add selectors to `TT_DOM_SELECTORS` in `.env` and restart the app.
* **`error` state with "Chromium is not reachable"** — `docker compose ps` and `docker compose logs chromium`; the
  browser needs about 1.5 GB per user.
* **Login loop / captcha loop** — make sure `TZ` in `.env` matches where you normally use the account (TikTok compares
  it with the IP's region), and prefer pasting a session from your own browser.

## Development

Server (Node 24) and web UI (React + Vite) are in `server/` and `web/`; the browser manager is Go in
`chromium/manager/`. `cd server && npm ci && npx vitest run`, `cd web && npm ci && npm run build`. Browser-dependent
checks without Docker: `cd server && npx tsx ../scripts/dev/dom-check.mts` (needs `PUPPETEER_EXECUTABLE_PATH`).
`scripts/smoke.sh` runs the whole stack in an isolated project. `AGENTS.md` (internal) and `ARCHITECTURE.md` describe
the conventions and the design.

## Licence

Private project of the repo owner; no licence is granted beyond what GitHub's terms allow for public repositories.
