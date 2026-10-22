import { z } from 'zod';

/**
 * A TikTok conversation id.
 *
 * A direct chat is `0:1:<uid>:<uid>` — **colons are part of the id** — and a group is a bare number (`7687…`). The
 * original pattern here was `^[A-Za-z0-9_-]+$`, which rejected every direct chat (the UI then showed
 * "chatId: Invalid string: must match pattern …") and happened to accept only groups. Anything that validates a
 * conversation id has to allow the colon.
 */
export const CHAT_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/;

export const ChatIdSchema = z.string().regex(CHAT_ID_PATTERN, 'Invalid chat id.');

export const ChatIdParam = z.object({ chatId: ChatIdSchema });
