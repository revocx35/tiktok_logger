import type { StoryMediaStatus, StoryStatus } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { F, type StoryRow } from '../db/repo.js';
import { deleteMediaFile, downloadToMedia, type Downloader } from './media.js';
import type { WebApi } from './web/api.js';

/**
 * Story logging, the way insta_logger does it.
 *
 * Every `storyIntervalMinutes` (± up to a quarter of it, random) the stories bar is read through TikTok's own web API
 * from the messages tab — `GET /api/story/user_list/` lists the accounts with live stories, and
 * `GET /api/story/batch/item_list/?authorIds=…` returns their items with the signed play address. Each item is stored
 * once (its id is the key), its photo or video is downloaded through the page into an encrypted media file, and stories
 * older than the retention setting are deleted with their files. Nothing is marked as seen and nothing is posted.
 *
 * These endpoints were read off TikTok's own web client (`api/story/…` from the desktop bundle); the tray call needs
 * `cursor` even on the first page — without it TikTok answers 400 `missing required fields`.
 */

export interface StoryDeps {
  /** The web API bound to the messages tab (null while TikTok is not connected). */
  api: () => WebApi | null;
  /** The page downloader (the CDN needs the tab's cookies, like the feed's videos). */
  downloader: () => Downloader | null;
}

/** Authors asked for in one batch call; TikTok accepts a comma-separated list. */
const BATCH = 20;
const TRAY_PAGES = 5;
const TRAY_COUNT = 10;
const MAX_AUTHORS_PER_RUN = 100;
const AVATARS_PER_RUN = 4;
const AVATAR_REFRESH_MS = 24 * 3600_000;
const GAP_MS = 1200;
const MAX_ATTEMPTS = 3;

export interface TrayUser {
  id: string;
  username: string | null;
  name: string | null;
  avatar: string | null;
}

export interface TrayPage {
  users: TrayUser[];
  cursor: string | null;
  hasMore: boolean;
}

export interface StoryItemRaw {
  id: string;
  authorId: string;
  type: 'image' | 'video';
  /** Story time in ms. */
  takenAt: number;
  /** When it stops being visible (ms), when TikTok says. */
  expiresAt: number | null;
  /** Signed media link (the smallest usable video, or the first photo). */
  url: string | null;
  mime: string;
  likes: number | null;
  plays: number | null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d{1,18}$/.test(v)) return Number(v);
  return null;
};
const ID = /^\d{6,24}$/;

/** The stories bar: accounts with live stories. Ads and non-story entries are skipped. */
export function parseTray(json: unknown): TrayPage {
  const root = obj(json);
  const users: TrayUser[] = [];
  for (const raw of arr(root.storyUsers)) {
    const e = obj(raw);
    const u = obj(e.user);
    const id = str(u.id);
    if (!id || !ID.test(id)) continue;
    users.push({
      id,
      username: str(u.uniqueId),
      name: str(u.nickname),
      avatar: str(u.avatarMedium) ?? str(u.avatarLarger) ?? str(u.avatarThumb),
    });
  }
  return { users, cursor: str(root.cursor), hasMore: root.hasMore === true };
}

/** The biggest of the photo candidates (TikTok serves the same photo in several sizes). */
function bestImage(imagePost: Record<string, unknown>): string | null {
  const images = arr(imagePost.images).map(obj);
  const candidates: { url: string; width: number }[] = [];
  for (const img of images) {
    for (const key of ['imageURL', 'imageUrl']) {
      const u = str(img[key]);
      if (u) candidates.push({ url: u, width: num(img.imageWidth) ?? 0 });
    }
    for (const d of arr(img.displayImage)) {
      const o = obj(d);
      const u = str(o.urlList) ?? str(o.url_list) ?? null;
      if (u) candidates.push({ url: u, width: num(o.width) ?? 0 });
    }
  }
  candidates.sort((a, b) => b.width - a.width);
  return candidates[0]?.url ?? null;
}

/**
 * One batch answer → the items per author.
 *
 * A story item is shaped like a video post (`video.playAddr`, `story.ExpiredAt`, `createTime` in seconds); photo
 * stories carry `imagePost` instead and no play address.
 */
export function parseBatch(json: unknown): { authorId: string; lastStoryAt: number | null; items: StoryItemRaw[] }[] {
  const out: { authorId: string; lastStoryAt: number | null; items: StoryItemRaw[] }[] = [];
  for (const raw of arr(obj(json).batchStoryItemLists)) {
    const list = obj(raw);
    const authorId = str(list.AuthorId);
    if (!authorId || !ID.test(authorId)) continue;
    const items: StoryItemRaw[] = [];
    for (const entry of arr(list.itemList)) {
      const it = obj(entry);
      const id = str(it.id);
      if (!id || !ID.test(id)) continue;
      const video = obj(it.video);
      const play = str(video.playAddr) ?? str(video.downloadAddr);
      const image = it.imagePost ? bestImage(obj(it.imagePost)) : null;
      const url = play ?? image;
      if (!url) continue; // a photo story without a usable link is skipped rather than stored empty
      const created = num(it.createTime);
      const story = obj(it.story);
      const stats = obj(it.stats);
      items.push({
        id,
        authorId,
        type: play ? 'video' : 'image',
        takenAt: created ? created * 1000 : Date.now(),
        expiresAt: num(story.ExpiredAt),
        url,
        mime: play ? 'video/mp4' : 'image/jpeg',
        likes: num(stats.diggCount),
        plays: num(stats.playCount),
      });
    }
    const last = num(list.LastStoryCreatedAt);
    out.push({ authorId, lastStoryAt: last, items });
  }
  return out;
}

/** Delay until the next check: the interval ± a random jitter of up to a quarter of it. */
export function storyDelay(minutes: number, random: () => number = Math.random): number {
  const interval = minutes * 60_000;
  const jitter = interval / 4;
  return Math.round(interval + (random() * 2 - 1) * jitter);
}

export class StoryLogger {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  lastCheckAt: number | null = null;
  nextCheckAt: number | null = null;
  lastResult: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: StoryDeps,
  ) {}

  status(): StoryStatus {
    const counts = this.ctx.repo.countStoriesByStatus();
    const authors = this.ctx.repo.listStoryUsers().length;
    return {
      logging: this.ctx.settings.get().storyLogging,
      lastCheckAt: this.lastCheckAt,
      nextCheckAt: this.nextCheckAt,
      lastResult: this.lastError ?? this.lastResult,
      authors,
      items: counts.total,
      pending: counts.pending,
      downloaded: counts.downloaded,
    };
  }

  /** Starts the timer when logging is on; safe to call repeatedly. */
  start(): void {
    this.stopped = false;
    this.reschedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
  }

  /** Settings changed: follow the toggle and the interval. */
  reconfigure(): void {
    if (!this.ctx.settings.get().storyLogging) {
      this.stop();
      return;
    }
    if (this.stopped) this.stopped = false;
    this.reschedule();
  }

  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || !this.ctx.settings.get().storyLogging) {
      this.nextCheckAt = null;
      return;
    }
    // First pass a few minutes after start (TikTok has just been logged in), then the configured interval.
    const delay = this.lastCheckAt ? storyDelay(this.ctx.settings.get().storyIntervalMinutes) : 3 * 60_000;
    this.nextCheckAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.checkNow().catch(() => undefined);
    }, delay);
    this.timer.unref?.();
  }

  /**
   * One pass: read the bar, store new items, download their media, sweep old stories.
   *
   * `manual` is the Settings page's button: an explicit check runs even while the schedule is off (that is how someone
   * tries the feature), while the timer never does.
   */
  async checkNow(opts: { manual?: boolean } = {}): Promise<StoryStatus> {
    if (!this.ctx.settings.get().storyLogging && !opts.manual) {
      this.lastResult = 'Story logging is off.';
      return this.status();
    }
    if (this.running) return this.status();
    this.running = true;
    try {
      const api = this.deps.api();
      if (!api) {
        this.lastError = 'TikTok is not connected.';
        return this.status();
      }
      const authors = await this.readTray(api);
      let stored = 0;
      let downloaded = 0;
      const selected = new Set(this.ctx.settings.get().storySelected);
      const wanted = authors.filter((a) => selected.size === 0 || selected.has(a.id)).slice(0, MAX_AUTHORS_PER_RUN);
      for (let i = 0; i < wanted.length; i += BATCH) {
        const chunk = wanted.slice(i, i + BATCH);
        const reply = await api.json('GET', '/api/story/batch/item_list/', { authorIds: chunk.map((a) => a.id).join(','), cursor: '0' });
        for (const group of parseBatch(reply)) {
          for (const item of group.items) {
            if (this.store(item)) stored++;
          }
          if (group.lastStoryAt) this.ctx.repo.markStoryUserCaptured(group.authorId, group.lastStoryAt, Date.now());
        }
        await sleep(GAP_MS);
      }
      downloaded += await this.fetchMedia(api);
      await this.fetchAvatars();
      const swept = await this.sweep();
      this.lastCheckAt = Date.now();
      this.lastError = null;
      this.lastResult = `${authors.length} author(s) with stories, ${stored} new item(s), ${downloaded} downloaded${swept ? `, ${swept} expired` : ''}.`;
      this.ctx.log.info({ authors: authors.length, stored, downloaded, swept }, 'stories checked');
      return this.status();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message.slice(0, 160) : 'stories check failed';
      this.ctx.log.warn({ reason: this.lastError }, 'stories check failed');
      return this.status();
    } finally {
      this.running = false;
      this.lastCheckAt = this.lastCheckAt ?? Date.now();
      this.reschedule();
    }
  }

  /** The stories bar, page by page (it is a cursor list; the first page still needs `cursor`). */
  private async readTray(api: WebApi): Promise<TrayUser[]> {
    const out = new Map<string, TrayUser>();
    let cursor = '0';
    for (let page = 0; page < TRAY_PAGES; page++) {
      const reply = await api.json('GET', '/api/story/user_list/', { count: String(TRAY_COUNT), cursor });
      const tray = parseTray(reply);
      const w = this.ctx.writer();
      for (const u of tray.users) {
        if (!out.has(u.id)) out.set(u.id, u);
        this.ctx.repo.upsertStoryUser({
          id: u.id,
          usernameEnc: u.username && w ? w.encrypt(...F.storyUsername(u.id), u.username) : null,
          nameEnc: u.name && w ? w.encrypt(...F.storyName(u.id), u.name) : null,
          avatarUrl: u.avatar,
          now: Date.now(),
        });
      }
      if (!tray.hasMore || !tray.cursor || tray.cursor === cursor) break;
      cursor = tray.cursor;
      await sleep(GAP_MS);
    }
    return [...out.values()];
  }

  /** Stores one item; false when it was already known. */
  private store(item: StoryItemRaw): boolean {
    const w = this.ctx.writer();
    return this.ctx.repo.insertStory({
      id: item.id,
      user_id: item.authorId,
      type: item.type,
      taken_at: item.takenAt,
      expires_at: item.expiresAt,
      media_id: null,
      mime_enc: w ? w.encrypt(...F.storyMime(item.id), item.mime) : null,
      likes: item.likes,
      plays: item.plays,
      status: 'pending',
    });
  }

  /**
   * Downloads the media of the newest pending stories.
   *
   * The signed links came with the batch answer, so a retry needs a fresh pass — a story that fails here stays pending
   * and is picked up by the next check (up to three attempts, then it is marked failed).
   */
  private async fetchMedia(api: WebApi): Promise<number> {
    const settings = this.ctx.settings.get();
    if (!settings.downloadHistoryMedia) return 0;
    const dl = this.deps.downloader();
    if (!dl) return 0;
    const maxBytes = settings.mediaMaxMb * 1024 * 1024;
    let done = 0;
    // The links are only in the batch answer, which this pass already consumed: re-read the pending list and fetch
    // each item's link from the author's batch (cheap, one call per author).
    const pending = this.ctx.repo.pendingStories(40);
    if (!pending.length) return 0;
    const byUser = new Map<string, StoryRow[]>();
    for (const row of pending) {
      const list = byUser.get(row.user_id) ?? [];
      list.push(row);
      byUser.set(row.user_id, list);
    }
    for (const [userId, rows] of byUser) {
      let links: { id: string; url: string; mime: string }[] = [];
      try {
        const reply = await api.json('GET', '/api/story/batch/item_list/', { authorIds: userId, cursor: '0' });
        links = parseBatch(reply)
          .flatMap((g) => g.items)
          .map((i) => ({ id: i.id, url: i.url ?? '', mime: i.mime }))
          .filter((l) => !!l.url);
      } catch {
        links = [];
      }
      const byId = new Map(links.map((l) => [l.id, l]));
      for (const row of rows) {
        const link = byId.get(row.id);
        if (!link) {
          // No link in this answer (expired, or the author's list changed): count the attempt so a dead item is not
          // retried for ever.
          const attempts = row.attempts + 1;
          this.ctx.repo.setStoryMedia(row.id, row.media_id, row.mime_enc, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending');
          continue;
        }
        try {
          const out = await downloadToMedia(this.ctx, dl, link.url, 'story', link.mime, maxBytes);
          const w = this.ctx.writer();
          const mimeEnc = w ? w.encrypt(...F.storyMime(row.id), link.mime) : null;
          if (out.status === 'ok') {
            this.ctx.repo.setStoryMedia(row.id, out.mediaId, mimeEnc, 'downloaded');
            done++;
          } else {
            const status: StoryMediaStatus = out.status === 'too_large' ? 'too_large' : row.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending';
            this.ctx.repo.setStoryMedia(row.id, null, mimeEnc, status);
          }
        } catch (e) {
          this.ctx.log.warn({ reason: e instanceof Error ? e.message.slice(0, 80) : 'download' }, 'story media download failed');
          this.ctx.repo.setStoryMedia(row.id, null, row.mime_enc, row.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending');
        }
        await sleep(GAP_MS);
      }
    }
    return done;
  }

  /** A few avatars per pass, so the authors list fills in without a burst. */
  private async fetchAvatars(): Promise<void> {
    const dl = this.deps.downloader();
    if (!dl) return;
    const rows = this.ctx.repo.storyUsersNeedingAvatar(Date.now() - AVATAR_REFRESH_MS, AVATARS_PER_RUN);
    for (const row of rows) {
      if (!row.avatar_url) continue;
      try {
        const out = await downloadToMedia(this.ctx, dl, row.avatar_url, 'avatar', 'image/jpeg', 2 * 1024 * 1024);
        this.ctx.repo.setStoryUserAvatar(row.id, out.status === 'ok' ? out.mediaId : null, Date.now());
      } catch {
        this.ctx.repo.setStoryUserAvatar(row.id, null, Date.now() - AVATAR_REFRESH_MS + 3600_000);
      }
      await sleep(GAP_MS);
    }
  }

  /** Deletes stories older than the retention setting, with their files. */
  async sweep(): Promise<number> {
    const days = this.ctx.settings.get().storyRetentionDays;
    const before = Date.now() - days * 24 * 3600_000;
    const rows = this.ctx.repo.storiesOlderThan(before);
    let n = 0;
    for (const row of rows) {
      if (row.media_id) {
        const media = this.ctx.repo.getMedia(row.media_id);
        if (media) {
          await deleteMediaFile(this.ctx, media.path).catch(() => undefined);
          this.ctx.repo.deleteMedia(media.id);
        }
      }
      this.ctx.repo.deleteStory(row.id);
      n++;
    }
    return n;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
