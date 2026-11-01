import { describe, expect, it } from 'vitest';
import { zipEntryName } from './media.js';

describe('zipEntryName', () => {
  it('names TikTok media tt_…, not with the Instagram prefix it was copied from', () => {
    const name = zipEntryName({ type: 'image', ts: Date.UTC(2026, 9, 10, 13, 5, 22) } as never, 'image/jpeg', null);
    expect(name).toBe('tt_photo_2026-10-10_13-05-22.jpg');
  });
});
