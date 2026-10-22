# tiktok_logger — notes for Claude sessions

Required reading, every session: `AGENTS.md` (layout, commands, conventions, never-do list, gotchas),
`ARCHITECTURE.md` (design source of truth), `docs/tiktok-notes.md` (TikTok Web facts), `docs/DEVLOG.md` (append a
section per session).

Rules: keep AGENTS.md, ARCHITECTURE.md, README and DEVLOG up to date in the same commit; never log message content,
cookies or media links; never weaken CSP/cookie flags/the Chromium sandbox; secret-scan before any push.
