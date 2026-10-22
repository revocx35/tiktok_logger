import type { FeedComment, FeedItem, StoryStatus, TtItem, TtStatus, SendMediaKind, SendResult } from '../../shared/api.js';
import type { Config } from './config.js';
import type { SessionCookie } from './tt/cookies.js';
import type { ShareArgs } from './tt/im/proto.js';
import type { ResolvedItem } from './tt/items.js';
import { Errors } from './errors.js';
import { DataWriter } from './crypto/keyring.js';
import type { Repo } from './db/repo.js';
import { Throttle } from './auth/throttle.js';
import type { EventBus } from './events.js';
import type { Logger } from './log.js';
import type { SettingsStore } from './settings.js';

/** Sending as the logged-in account (throws AppError: unavailable when TikTok is not connected). */
export interface TtSender {
  sendText(chatId: string, text: string, quotedId: string | null, quotedText?: string | null): Promise<SendResult>;
  /** Shares a TikTok post into a conversation as a card (not a link). */
  sendShare(chatId: string, share: ShareArgs): Promise<SendResult>;
  sendMedia(chatId: string, file: { data: Buffer; mime: string; filename: string | null }, kind: SendMediaKind, quotedId: string | null): Promise<SendResult>;
  /** An empty emoji removes the owner's reaction ([previous]: the emoji being removed, TikTok needs it). */
  react(messageId: string, emoji: string, previous?: string | null): Promise<void>;
  /** Unsend (removes the message for everyone). */
  unsend(messageId: string): Promise<void>;
  edit(messageId: string, text: string): Promise<void>;
  markRead(chatId: string): Promise<void>;
}

/** The For You feed (its own tab; browsing only, nothing is stored). */
export interface TtFeed {
  current(): Promise<FeedItem | null>;
  /** The video in view plus the next few, for a swiping client. */
  window(limit?: number): Promise<{ items: FeedItem[]; current: string | null }>;
  /** Moves the remote page to a video the client swiped to. */
  goto(id: string): Promise<{ items: FeedItem[]; current: string | null }>;
  step(dir: 'next' | 'prev'): Promise<FeedItem>;
  /** Sends a feed video into a conversation as a TikTok card (what TikTok's own share does). */
  share(id: string, chatId: string): Promise<{ id: string }>;
  like(id: string, want: boolean): Promise<{ liked: boolean }>;
  comments(id: string): Promise<FeedComment[]>;
  comment(id: string, text: string): Promise<FeedComment[]>;
  closeComments(): Promise<void>;
  /** The bytes behind a media reference (video or poster), from the prefetched cache when possible. */
  mediaOf(ref: string): Promise<{ mime: string; data: Buffer } | null>;
  mediaCached(ref: string): boolean;
  mediaStats(): { refs: number; cached: number; bytes: number; inflight: number };
}

/** Story logging (see tt/stories.ts), used by the HTTP layer. */
export interface TtStories {
  status(): StoryStatus;
  /** Runs one pass now (the Stories page's "check now" button runs it even while the schedule is off). */
  checkNow(opts?: { manual?: boolean }): Promise<StoryStatus>;
  /** Follows the story settings (toggle, interval). */
  reconfigure(): void;
  /** Deletes stories past the retention setting, with their files. */
  sweep(): Promise<number>;
}

/** One TikTok post, for the chat's shared videos and pasted links (see tt/items.ts). */
export interface TtItemsApi {
  /** Resolves it through the logged-in tab (cached); throws not_found when TikTok does not have it. */
  lookup(id: string): Promise<ResolvedItem>;
  /** The video or cover bytes (downloaded once through the page). */
  bytes(id: string, kind: 'video' | 'cover'): Promise<{ mime: string; data: Buffer } | null>;
  cached(id: string, kind: 'video' | 'cover'): boolean;
  /** The DTO the HTTP layer serves. */
  dto(item: ResolvedItem): TtItem;
  /** Forgets everything (logout, reconnect). */
  reset(): void;
}

/** Control surface of the TikTok integration, used by the HTTP layer. */
export interface TtController {
  status(): TtStatus;
  /** Idempotent. Starts connecting to Chromium / TikTok. */
  start(): Promise<void>;
  /** Reconnects to Chromium and reloads the TikTok tab. */
  restart(): Promise<void>;
  /** Logs the TikTok tab out (the owner logs in again on the TikTok screen). */
  logout(): Promise<void>;
  /** Logs in with a session (cookies) from the owner's own browser, instead of the login form. */
  importSession(cookies: SessionCookie[]): Promise<void>;
  /** Re-queues a media download. Returns false if the message has no retryable media. */
  retryMedia(messageId: string): boolean;
  /** Called after all logged data was wiped (drop in-memory caches). */
  onDataWiped(): void;
  /** What the capture layer is seeing (counts, recent IM paths) — no content, safe to show in Settings. */
  diagnostics(): TtDiagnostics;
  /** A structure outline of the messages page (tags, data-e2e, class name stems only), for selector tuning. */
  probePage(): Promise<PageProbe | null>;
  stop(): Promise<void>;
  readonly sender: TtSender;
  readonly feed: TtFeed;
  readonly stories: TtStories;
  readonly items: TtItemsApi;
}

export interface TtDiagnostics {
  state: TtStatus['state'];
  detail?: string;
  watcher: { frames: number; bodies: number; lastFrameAt: number | null; sockets: number; recentPaths: string[] };
  chats: number;
  messages: number;
  meId: string | null;
}

export interface PageProbe {
  url: string;
  title: string;
  nodes: unknown[];
}

export class AppContext {
  private writerInstance: DataWriter | null = null;
  tt: TtController;
  /** Every registered route (filled by an onRoute hook) — used by the auth coverage test. */
  readonly routeTable: { method: string; url: string; public: boolean }[] = [];
  /** Brute-force throttle shared by every credential check. */
  readonly throttle: Throttle;

  constructor(
    readonly config: Config,
    readonly log: Logger,
    readonly repo: Repo,
    readonly events: EventBus,
    readonly settings: SettingsStore,
    tt?: TtController,
  ) {
    this.tt = tt ?? new NullTt();
    this.throttle = new Throttle(repo);
  }

  /** The encryptor for new data; null until an owner (and thus a public key) exists. */
  writer(): DataWriter | null {
    if (this.writerInstance) return this.writerInstance;
    const owner = this.repo.getOwner();
    if (!owner) return null;
    this.writerInstance = new DataWriter(this.repo, owner.public_key);
    return this.writerInstance;
  }

  /** Drops the encryptor after the account's keys were replaced (wipe); the next writer() builds a new one. */
  resetWriter(): void {
    this.writerInstance = null;
  }

  mediaMaxBytes(): number {
    return this.settings.get().mediaMaxMb * 1024 * 1024;
  }
}

const notConnected = async (): Promise<never> => {
  throw Errors.unavailable('TikTok is not connected.');
};

export class NullTt implements TtController {
  private readonly since = Date.now();
  readonly feed: TtFeed = {
    current: async () => null,
    window: async () => ({ items: [], current: null }),
    goto: notConnected,
    step: notConnected,
    share: notConnected,
    like: notConnected,
    comments: notConnected,
    comment: notConnected,
    closeComments: async () => undefined,
    mediaOf: async () => null,
    mediaCached: () => false,
    mediaStats: () => ({ refs: 0, cached: 0, bytes: 0, inflight: 0 }),
  };
  readonly stories: TtStories = {
    status: () => ({ logging: false, lastCheckAt: null, nextCheckAt: null, lastResult: 'TikTok is not connected.', authors: 0, items: 0, pending: 0, downloaded: 0 }),
    checkNow: notConnected,
    reconfigure: () => undefined,
    sweep: async () => 0,
  };
  readonly items: TtItemsApi = {
    lookup: notConnected,
    bytes: notConnected,
    cached: () => false,
    dto: () => {
      throw Errors.unavailable('TikTok is not connected.');
    },
    reset: () => undefined,
  };
  readonly sender: TtSender = {
    sendText: notConnected,
    sendShare: notConnected,
    sendMedia: notConnected,
    react: notConnected,
    unsend: notConnected,
    edit: notConnected,
    markRead: notConnected,
  };
  status(): TtStatus {
    return { state: 'idle', mediaQueue: 0, since: this.since, sync: null, lastEventAt: null };
  }
  async start(): Promise<void> {}
  async restart(): Promise<void> {}
  async logout(): Promise<void> {}
  async importSession(_cookies: SessionCookie[]): Promise<void> {
    throw Errors.unavailable('TikTok is not enabled.');
  }
  retryMedia(): boolean {
    return false;
  }
  onDataWiped(): void {}
  diagnostics(): TtDiagnostics {
    return { state: 'idle', watcher: { frames: 0, bodies: 0, lastFrameAt: null, sockets: 0, recentPaths: [] }, chats: 0, messages: 0, meId: null };
  }
  async probePage(): Promise<PageProbe | null> {
    return null;
  }
  async stop(): Promise<void> {}
}
