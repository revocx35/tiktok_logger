/**
 * Live check of the v1.15 social layer against the running browser. Prints structure and states only (never names,
 * texts or links). Every action is undone in the same run. Bundle with esbuild and run next to the browser:
 *
 *   npx esbuild scripts/dev/social-check.mts --bundle --platform=node --format=esm --outfile=/tmp/social-check.mjs \
 *     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
 *   node social-check.mjs <devtools-port> [account=tiktok] [--act]
 *
 * Without --act it only reads. With --act it likes+unlikes, reposts+un-reposts and follows+unfollows on [account]'s
 * newest video / profile — use a public account the owner agreed to (default @tiktok).
 */
import puppeteer from 'puppeteer-core';
import { ApiFeed } from '../../server/src/tt/feedApi.js';
import { PageActions } from '../../server/src/tt/pageActions.js';
import { WebApi } from '../../server/src/tt/web/api.js';

const port = process.argv[2] ?? '9222';
const account = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'tiktok';
const act = process.argv.includes('--act');
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
const pages = await browser.pages();
const messages = pages.find((p) => p.url().includes('/messages'));
if (!messages) throw new Error('no messages tab');
const api = new WebApi(messages);
const audit: string[] = [];
const ctx = { log: { warn: () => undefined, info: () => undefined }, repo: { audit: (e: string) => audit.push(e) } } as never;
let window: Awaited<ReturnType<typeof browser.newPage>> | null = null;
const actions = new PageActions(async () => {
  window ??= await browser.newPage({ type: 'window' } as never);
  return { page: window, origin: 'https://www.tiktok.com' };
});
const feed = new ApiFeed(ctx, () => api, () => null, {
  like: async (id, author, want) => ({ liked: await actions.onVideo(author!, id, 'like', want) }),
  repost: async (id, author, want) => ({ reposted: await actions.onVideo(author, id, 'repost', want) }),
  follow: async (u, want) => ({ following: await actions.follow(u, want) }),
});
const t0 = Date.now();
const step = async <T>(name: string, fn: () => Promise<T>, show: (r: T) => unknown = () => 'ok'): Promise<T | null> => {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`${name.padEnd(22)} ${String(Date.now() - t).padStart(6)} ms  ${JSON.stringify(show(r))}`);
    return r;
  } catch (e) {
    console.log(`${name.padEnd(22)} ${String(Date.now() - t).padStart(6)} ms  ERROR ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`);
    return null;
  }
};
try {
  const me = await step('profile me', () => feed.profile('me'), (p) => ({ tabs: p.tabs, stats: Object.keys(p.stats), avatar: !!p.avatar }));
  for (const tab of me?.tabs ?? []) await step(`my ${tab}`, () => feed.profileVideos('me', tab, null), (r) => ({ n: r.items.length, more: r.more }));
  const p = await step(`profile @${account}`, () => feed.profile(account), (x) => ({ following: x.following, tabs: x.tabs }));
  const vids = await step('videos', () => feed.profileVideos(account, 'videos', null), (r) => ({ n: r.items.length, more: r.more, captions: r.items.filter((i) => i.video?.captions?.length).length, canRepost: r.items.filter((i) => i.canRepost).length }));
  const page2 = vids?.cursor ? await step('videos page 2', () => feed.profileVideos(account, 'videos', vids.cursor), (r) => ({ n: r.items.length })) : null;
  void page2;
  const v = vids?.items[0];
  if (v) {
    const cs = await step('comments', () => feed.comments(v.id), (c) => ({ n: c.length, withReplies: c.filter((x) => (x.replyCount ?? 0) > 0).length }));
    const top = cs?.find((x) => (x.replyCount ?? 0) > 0);
    if (top) await step('replies', () => feed.replies(v.id, top.id, null), (r) => ({ n: r.comments.length, more: r.more }));
    if (act && p) {
      const liked0 = v.liked;
      await step('like', () => feed.like(v.id, !liked0), (r) => r);
      await step('like (undo)', () => feed.like(v.id, liked0), (r) => r);
      await step('repost', () => feed.repost(v.id, true), (r) => r);
      await step('repost (undo)', () => feed.repost(v.id, false), (r) => r);
      const f0 = p.following ?? false;
      await step('follow', () => feed.follow(account, !f0), (r) => r);
      await step('follow (undo)', () => feed.follow(account, f0), (r) => r);
      if (top) {
        await step('comment like', () => feed.likeComment(v.id, top.id, !top.liked), (r) => r);
        await step('comment like (undo)', () => feed.likeComment(v.id, top.id, !!top.liked), (r) => r);
      }
    }
  }
  console.log('audit', audit, 'total', Date.now() - t0, 'ms');
} finally {
  if (window) await (window as { close(): Promise<void> }).close().catch(() => undefined);
  await browser.disconnect();
}
