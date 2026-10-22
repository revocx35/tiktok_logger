import { describe, expect, it } from 'vitest';
import { FeedCatalog } from './feed.js';

/**
 * The For You tab renders through MSE, so `video.src` is a `blob:` URL and the item carries no link to its own id —
 * both only exist in the page's `/api/recommend/item_list/` JSON. The catalog holds that and matches it to what the
 * DOM shows (author + the start of the caption, which TikTok truncates).
 */
const body = (items: unknown[]) => Buffer.from(JSON.stringify({ status_code: 0, itemList: items }));

const item = (id: string, uniqueId: string, desc: string, extra: Record<string, unknown> = {}) => ({
  id,
  desc,
  author: { uniqueId, nickname: uniqueId.toUpperCase() },
  video: { playAddr: `https://v16.tiktokcdn.com/${id}.mp4`, cover: `https://p16.tiktokcdn.com/${id}.jpg` },
  music: { title: 'original sound' },
  stats: { diggCount: 1200, commentCount: 7, shareCount: 3, playCount: 34000 },
  ...extra,
});

describe('FeedCatalog', () => {
  it('reads ids and signed video urls out of the item list', () => {
    const c = new FeedCatalog();
    c.ingest(body([item('7412345678901234567', 'ali.veli', 'first video caption #test')]));
    const hit = c.find('ali.veli', 'first video caption #test');
    expect(hit?.id).toBe('7412345678901234567');
    expect(hit?.playAddr).toBe('https://v16.tiktokcdn.com/7412345678901234567.mp4');
    expect(hit?.cover).toBe('https://p16.tiktokcdn.com/7412345678901234567.jpg');
    expect(hit?.likes).toBe(1200);
    expect(hit?.plays).toBe(34000);
  });

  it('matches a caption the DOM truncated with an ellipsis', () => {
    const c = new FeedCatalog();
    const long = 'a long caption that TikTok cuts off in the overlay because it does not fit on one screen';
    c.ingest(body([item('7412345678901234568', 'ayse', long)]));
    expect(c.find('ayse', 'a long caption that TikTok cuts off in the…')?.id).toBe('7412345678901234568');
  });

  it('never pairs an author with someone else’s caption, and does not guess from an author alone', () => {
    const c = new FeedCatalog();
    c.ingest(body([item('7412345678901234569', 'someone.else', 'hello')]));
    // different author, different caption: nothing to match
    expect(c.find('ali.veli', 'a caption nobody posted')).toBeNull();
    // the caption matches but the author does not: the caption is unique enough to win (2 points)
    expect(c.find('ali.veli', 'hello')?.id).toBe('7412345678901234569');
    // the author matches but the caption does not: too weak on its own
    expect(c.find('someone.else', 'unrelated caption text')).toBeNull();
  });

  it('keeps the later of two items with the same caption (the feed moved on)', () => {
    const c = new FeedCatalog();
    c.ingest(body([item('7412345678901234570', 'ali.veli', 'same')]));
    c.ingest(body([item('7412345678901234571', 'ali.veli', 'same')]));
    expect(c.find('ali.veli', 'same')?.id).toBe('7412345678901234571');
  });

  it('finds the item by the id the DOM carries (more-actions button)', () => {
    const c = new FeedCatalog();
    c.ingest(body([item('7672873021899574550', 'proudfenian', 'a caption')]));
    expect(c.byIdLookup('7672873021899574550')?.playAddr).toBe('https://v16.tiktokcdn.com/7672873021899574550.mp4');
    expect(c.byIdLookup('7000000000000000000')).toBeNull();
    expect(c.byIdLookup(null)).toBeNull();
  });

  it('survives junk: not JSON, no item list, ids that are not ids', () => {
    const c = new FeedCatalog();
    c.ingest(Buffer.from('not json'));
    c.ingest(Buffer.from(JSON.stringify({ itemList: 'nope' })));
    c.ingest(body([{ id: 'x', author: {} }, item('7412345678901234572', 'ok.user', 'fine')]));
    expect(c.find('ok.user', 'fine')?.id).toBe('7412345678901234572');
    expect(c.find('x', null)).toBeNull();
  });

  it('forgets the oldest entries beyond 300', () => {
    const c = new FeedCatalog();
    for (let i = 0; i < 320; i++) c.ingest(body([item(`70000000000000${String(i).padStart(5, '0')}`, 'bulk', `caption ${i}`)]));
    expect(c.size).toBe(300);
    expect(c.find('bulk', 'caption 0')).toBeNull();
    expect(c.find('bulk', 'caption 319')).not.toBeNull();
  });

  it('lists what follows a video in feed order, across batches', () => {
    const c = new FeedCatalog();
    c.ingest(body([item('7400000000000000001', 'a', 'one'), item('7400000000000000002', 'b', 'two')]));
    c.ingest(body([item('7400000000000000003', 'c', 'three'), item('7400000000000000002', 'b', 'two')]));
    expect(c.after('7400000000000000001', 5).map((x) => x.author)).toEqual(['b', 'c']);
    expect(c.after('7400000000000000003', 5)).toEqual([]);
    expect(c.after('7499999999999999999', 5)).toEqual([]);
    expect(c.after(null, 5)).toEqual([]);
    expect(c.indexOf('7400000000000000003')).toBe(2);
  });

  it('keeps the author card and the like state, and remembers a like made through the app', () => {
    const c = new FeedCatalog();
    c.ingest(body([item('7400000000000000009', 'z', 'zed', { digged: false, author: { uniqueId: 'z', nickname: 'Zed', avatarThumb: 'https://p16.tiktokcdn.com/z.jpg' } })]));
    const it1 = c.byIdLookup('7400000000000000009')!;
    expect(it1.authorName).toBe('Zed');
    expect(it1.avatar).toBe('https://p16.tiktokcdn.com/z.jpg');
    expect(it1.liked).toBe(false);
    c.markLiked('7400000000000000009', true);
    expect(c.byIdLookup('7400000000000000009')).toMatchObject({ liked: true, likes: 1201 });
    c.markLiked('7400000000000000009', true);
    expect(c.byIdLookup('7400000000000000009')?.likes).toBe(1201);
  });
});
