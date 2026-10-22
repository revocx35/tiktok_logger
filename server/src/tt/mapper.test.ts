import { describe, expect, it } from 'vitest';
import { domRowToMessage, domThreadToThread, mapMessage, mapThread, mapUser, walkCandidates } from './mapper.js';
import { isSyntheticId } from './types.js';

const ME = { id: '7000000000000000001', username: 'owner', name: 'Owner' };
const NOW = 1_760_000_000_000; // fixed clock

describe('mapUser', () => {
  it('reads the sender shapes TikTok uses', () => {
    expect(mapUser({ uid: '123', nickname: 'Ali', uniqueId: 'ali' })).toMatchObject({ id: '123', name: 'Ali', username: 'ali' });
    expect(mapUser({ user_id: '456', nick_name: 'Ayşe', avatar_thumb: { url_list: ['https://p16.tiktokcdn.com/a.jpg'] } })).toMatchObject({
      id: '456',
      name: 'Ayşe',
      avatarUrl: 'https://p16.tiktokcdn.com/a.jpg',
    });
    expect(mapUser('789')).toEqual({ id: '789' });
  });

  it('refuses an object without a numeric user id', () => {
    expect(mapUser({ nickname: 'nobody' })).toBeNull();
    expect(mapUser({ uid: 'abc' })).toBeNull();
  });
});

describe('mapThread', () => {
  it('maps a conversation object with the peer and the last message', () => {
    const t = mapThread(
      {
        conversation_id: 'conv-1',
        conversation_name: 'Ali',
        participant_count: 2,
        last_message: { content: '{"text":"see you","aweType":700}', create_time: 1_759_999_000 },
        unread_count: 3,
        is_pinned: true,
      },
      { meId: ME.id, now: NOW },
    );
    expect(t).toMatchObject({ id: 'conv-1', kind: 'user', name: 'Ali', lastText: 'see you', unread: 3, pinned: true });
    expect(t!.lastTs).toBe(1_759_999_000_000);
  });

  it('needs an id', () => {
    expect(mapThread({ name: 'Ali' }, { meId: ME.id, now: NOW })).toBeNull();
  });
});

describe('mapMessage', () => {
  const base = { conversation_id: 'conv-1', create_time: 1_759_999_000 };

  it('maps a text message that carries TikTok JSON in `content`', () => {
    const m = mapMessage(
      { ...base, server_message_id: 'srv-9', sender: { uid: '42', nickname: 'Ali' }, content: JSON.stringify({ text: 'hi there', aweType: 700 }) },
      null,
      { meId: ME.id, now: NOW },
    );
    expect(m).toMatchObject({ id: 'srv-9', threadId: 'conv-1', senderId: '42', fromMe: false, type: 'text', text: 'hi there' });
    expect(m!.ts).toBe(1_759_999_000_000);
  });

  it('marks own messages by the account id', () => {
    const m = mapMessage({ ...base, message_id: 'm1', sender: { uid: ME.id }, content: '{"text":"mine"}' }, null, { meId: ME.id, now: NOW });
    expect(m!.fromMe).toBe(true);
  });

  it('maps a sticker with its media url', () => {
    const m = mapMessage(
      {
        ...base,
        message_id: 'm2',
        sender: { uid: '42' },
        content: JSON.stringify({ aweType: 500 }),
        sticker: { url_list: ['https://p16.tiktokcdn.com/sticker.webp?x-sign=1'], width: 240, height: 240 },
      },
      null,
      { meId: ME.id, now: NOW },
    );
    expect(m!.type).toBe('sticker');
    expect(m!.media).toHaveLength(1);
    expect(m!.media![0]!.kind).toBe('sticker');
  });

  it('maps a photo message with its dimensions', () => {
    const m = mapMessage(
      { ...base, message_id: 'm3', sender: { uid: '42' }, image: { url_list: ['https://p19.tiktokcdn.com/a.jpeg'], width: 1080, height: 1440 } },
      null,
      { meId: ME.id, now: NOW },
    );
    expect(m!.type).toBe('media');
    expect(m!.media![0]).toMatchObject({ kind: 'image', width: 1080, height: 1440 });
  });

  it('keeps a message it cannot read instead of dropping it', () => {
    const m = mapMessage({ ...base, message_id: 'm4', sender: { uid: '42' }, msg_type: 'weird_type_99' }, null, { meId: ME.id, now: NOW });
    expect(m).not.toBeNull();
    expect(m!.type).toBe('weird_type_99');
    expect(m!.meta?.unreadable).toBe(true);
  });

  it('rejects junk that merely looks like a message', () => {
    expect(mapMessage({ id: 'm', create_time: 1_759_999_000 }, null, { meId: ME.id, now: NOW })).toBeNull(); // no conversation
    expect(mapMessage({ conversation_id: 'conv-1', message_id: 'm5', content: 'x' }, null, { meId: ME.id, now: NOW })).toBeNull(); // no time
    expect(mapMessage({ conversation_id: 'conv-1', message_id: 'm6', create_time: 1_000_000 }, null, { meId: ME.id, now: NOW })).toBeNull(); // 1970
  });

  it('gives a content-derived id when TikTok sent none', () => {
    const a = mapMessage({ ...base, content: '{"text":"same"}' }, null, { meId: ME.id, now: NOW })!;
    const b = mapMessage({ ...base, content: '{"text":"same"}' }, null, { meId: ME.id, now: NOW })!;
    expect(isSyntheticId(a.id)).toBe(true);
    expect(a.id).toBe(b.id);
  });
});

describe('DOM rows', () => {
  it('maps a text row and a deleted row', () => {
    const m = domRowToMessage('conv-1', { i: 0, text: 'hello', mine: false, ts: NOW - 5000, senderName: 'Ali' }, { meId: ME.id, now: NOW });
    expect(m).toMatchObject({ threadId: 'conv-1', fromMe: false, type: 'text', text: 'hello' });

    const d = domRowToMessage('conv-1', { i: 1, text: 'Message deleted', deleted: true, ts: NOW }, { meId: ME.id, now: NOW });
    expect(d!.type).toBe('system');
  });

  it('keeps a media row without text', () => {
    const m = domRowToMessage('conv-1', { i: 0, mine: true, media: [{ url: 'https://p16.tiktokcdn.com/v.mp4', kind: 'video' }] }, { meId: ME.id, now: NOW });
    expect(m!.media![0]!.kind).toBe('video');
    expect(m!.fromMe).toBe(true);
  });

  it('maps a conversation row, deriving a stable id from the name when there is none', () => {
    const a = domThreadToThread({ name: 'Ali Veli', lastText: 'hi' }, { meId: ME.id, now: NOW })!;
    const b = domThreadToThread({ name: 'Ali Veli', lastText: 'different' }, { meId: ME.id, now: NOW })!;
    expect(a.id).toBe(b.id);
    expect(a.id.startsWith('nm:')).toBe(true);
    expect(domThreadToThread({ name: 'Ali', id: 'conv-7' }, { meId: ME.id, now: NOW })!.id).toBe('conv-7');
  });
});

describe('walkCandidates', () => {
  it('finds records buried in an answer', () => {
    const answer = { status_code: 0, data: { conversations: [{ conversation_id: 'c1', messages: [{ message_id: 'm1', create_time: 1 }] }] } };
    const objs = walkCandidates(answer);
    expect(objs.some((o) => 'conversation_id' in o)).toBe(true);
    expect(objs.some((o) => 'message_id' in o)).toBe(true);
  });

  it('is bounded', () => {
    const big = { items: Array.from({ length: 2000 }, (_, i) => ({ i })) };
    expect(walkCandidates(big, 50).length).toBeLessThanOrEqual(50);
  });
});
