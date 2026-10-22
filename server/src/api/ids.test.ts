import { describe, expect, it } from 'vitest';
import { ChatIdParam, ChatIdSchema } from './ids.js';

const DIRECT = '0:1:7569493869424952327:7630385732910482448';
const GROUP = '7687822150502072596';

describe('chat id validation', () => {
  it('accepts a direct chat id (colons are part of it)', () => {
    expect(ChatIdParam.parse({ chatId: DIRECT }).chatId).toBe(DIRECT);
    expect(ChatIdSchema.safeParse(DIRECT).success).toBe(true);
  });

  it('accepts a group id', () => {
    expect(ChatIdSchema.safeParse(GROUP).success).toBe(true);
  });

  it('still refuses path tricks and whitespace', () => {
    for (const bad of ['../etc/passwd', 'a/b', 'a b', 'a?b', 'a#b', '%2e%2e', '']) {
      expect(ChatIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('refuses an over-long id', () => {
    expect(ChatIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});
