import type { Browser, Page } from 'puppeteer';
import puppeteer from 'puppeteer';
import type { SendMediaKind, SendResult, TtState, TtStatus } from '../../../shared/api.js';
import type { AppContext, PageProbe, TtController, TtDiagnostics, TtFeed, TtSender } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { maskId } from '../log.js';
import { classifyUrl, closeOtherTabs, pickTikTokTab } from './browser.js';
import { ChromiumLink } from './chromium.js';
import type { SessionCookie } from './cookies.js';
import { DEFAULT_SELECTORS, DomAgent, mergeSelectors, type DomSelectors } from './dom.js';
import type { ChatDriver } from './driver.js';
import { BrowserDownloader } from './download.js';
import { FeedCatalog, FeedService } from './feed.js';
import { ApiFeed } from './feedApi.js';
import { WebApi } from './web/api.js';
import { Ingest, MediaSources } from './ingest.js';
import { lookAtTab, nextLoginStep, setSessionCookies, steerTab } from './loginwatch.js';
import { MediaQueue } from './media.js';
import { domRowToMessage, domThreadToThread, mapMessage, mapThread, mapUser, walkCandidates } from './mapper.js';
import { ImEngine } from './im/engine.js';
import { ImTransport } from './im/transport.js';
import { Sender } from './sender.js';
import { Sync } from './sync.js';
import { isOpaqueId, type TtMessage, type TtThread, type TtUser, type ThreadSnapshot } from './types.js';
import { Watcher } from './watcher.js';

/**
 * The TikTok integration: one browser tab, one state machine.
 *
 * `start()` connects to this tenant's Chromium, opens `tiktok.com/messages`, and waits — without attaching anything
 * to the page — until the cookie jar holds a TikTok login (the owner logs in on the TikTok screen / noVNC, or pastes
 * a session). Only then does it attach: the Watcher reads TikTok's own message stream and IM answers, the DomAgent
 * reads and drives the page. Then the initial history import runs, the state becomes `ready`, and three loops keep
 * the log current: the open conversation is read every few seconds, the conversation list every ~15 s, and the newest
 * conversations are re-read every `reconcileMinutes` to notice unsent messages.
 */
export class TtService implements TtController, ChatDriver {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private watcher: Watcher | null = null;
  private agentRef: DomAgent | null = null;
  private downloaderRef: BrowserDownloader | null = null;
  /** The IM protocol engine (null → the page-driving fallback is in use). */
  private engineRef: ImEngine | null = null;
  private state: TtState = 'idle';
  private detail: string | undefined;
  private since = Date.now();
  private me: TtStatus['me'];
  private syncInfo: TtStatus['sync'] = null;
  private lastEventAt: number | null = null;
  private connecting = false;
  private stopped = false;
  private attempt = 0;
  private gen = 0;
  /** True when this process connected the browser itself (a test's browser is left alone on teardown). */
  private weConnected = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly timers = new Set<NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastPollAt = 0;
  private lastThreadListAt = 0;
  private openChatId: string | null = null;
  private readonly chatKeys = new Map<string, string>();
  private readonly seenWindows = new Map<string, { from: number; to: number; ids: Set<string> }>();
  private pendingReconcile = false;

  readonly chromium: ChromiumLink;
  readonly sources = new MediaSources();
  readonly media: MediaQueue;
  readonly ingest: Ingest;
  readonly sender: TtSender;
  readonly sync: Sync;
  /** The feed the HTTP layer talks to: the web API when it is active, else the page-driving one. */
  readonly feed: TtFeed;
  private readonly pageFeed: FeedService;
  private readonly apiFeed: ApiFeed;
  private webApiRef: WebApi | null = null;
  /** Item ids and signed video URLs captured from the For You page's own JSON. */
  private readonly feedCatalog = new FeedCatalog();
  /** The For You tab (created on demand, kept for the session; never the messages tab). */
  private feedPageRef: Page | null = null;
  /** A second watcher for the feed tab: only its \`/api/recommend/item_list/\` answers are wanted. */
  private feedWatcher: Watcher | null = null;
  private selectors: DomSelectors;

  /**
   * @param connectHook test seam: hands the service a browser that is already connected (scripts/dev/service-check.mts
   * uses it with a local Chromium). The real deployment passes nothing and goes through the chromium manager.
   */
  constructor(
    private readonly ctx: AppContext,
    private readonly connectHook?: (link: ChromiumLink) => Promise<{ browser: Browser; page: Page }>,
  ) {
    this.chromium = ChromiumLink.fromConfig(ctx.config);
    this.selectors = mergeSelectors(ctx.config.ttDomSelectors);
    this.media = new MediaQueue(ctx, {
      downloader: () => this.downloaderRef,
      sources: this.sources,
      refresh: (row) => this.refreshMessage(row.id, row.chat_id),
    });
    this.ingest = new Ingest(ctx, ctx.events, this.sources, this.media);
    this.sender = new Sender(ctx, this.ingest, this);
    this.pageFeed = new FeedService(ctx, { feedPage: () => this.feedPage() }, this.feedCatalog);
    this.apiFeed = new ApiFeed(ctx, () => this.webApiRef, () => this.downloaderRef);
    this.feed = routedFeed(() => (this.webApiRef ? this.apiFeed : null), this.pageFeed);
    this.sync = new Sync(ctx, {
      threads: () => this.readThreads(),
      openChat: (id) => this.ensureChatOpen(id),
      snapshot: () => this.snapshot(),
      afterChat: (chatId, snap, phase) => this.afterChat(chatId, snap, phase),
      progress: (phase, done, total) => {
        this.syncInfo = { phase, chatsDone: done, chatsTotal: total };
        this.ctx.events.emit({ type: 'sync_progress', sync: this.syncInfo });
      },
    });
  }

  /* ---------------------------------------------------------------- status */

  status(): TtStatus {
    return {
      state: this.state,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.me ? { me: this.me } : {}),
      sync: this.syncInfo,
      mediaQueue: this.media.size(),
      lastEventAt: this.lastEventAt,
      since: this.since,
    };
  }

  private setState(state: TtState, detail?: string): void {
    const changed = state !== this.state || detail !== this.detail;
    this.state = state;
    this.detail = detail;
    if (changed) this.ctx.events.emit({ type: 'tt_state', status: this.status() });
  }

  /* ------------------------------------------------------------- lifecycle */

  async start(): Promise<void> {
    if (this.stopped || !this.ctx.config.ttEnabled) return;
    await this.connect(false);
  }

  async restart(): Promise<void> {
    await this.teardown();
    this.stopped = false;
    this.since = Date.now();
    await this.connect(true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.teardown();
    this.setState('idle');
  }

  /** Logs the TikTok tab out: the owner logs in again on the TikTok screen. */
  async logout(): Promise<void> {
    await this.teardown();
    this.stopped = false;
    this.since = Date.now();
    this.me = undefined;
    this.ingest.me = null;
    this.openChatId = null;
    this.chatKeys.clear();
    this.setState('login', 'Logged out. Log in on the TikTok screen.');
    // Removing the cookies is enough; the next tick sees "logged out" and points the tab at the login page.
    await this.clearCookies().catch(() => undefined);
    this.scheduleConnect(1500);
  }

  /** Logs in with the session of the owner's own browser (cookies from a request to www.tiktok.com). */
  async importSession(cookies: SessionCookie[]): Promise<void> {
    if (cookies.length === 0) throw Errors.validation('No cookies were found.');
    const origin = this.ctx.config.ttWebOrigin;
    const target = this.chromium.cdpTarget();
    if (!(await this.chromium.ensure())) throw Errors.unavailable('The browser is not reachable yet. Try again in a moment.');
    await setSessionCookies(target, origin, cookies);
    this.ctx.repo.audit('tt_session_imported', null, `${cookies.length} cookies`);
    // Reload so TikTok's own client picks the new cookies up, then connect normally.
    await steerTab(target, null, { goto: `${origin}/messages` }).catch(() => undefined);
    await this.teardown();
    this.stopped = false;
    this.since = Date.now();
    this.attempt = 0;
    this.scheduleConnect(1000);
  }

  onDataWiped(): void {
    this.sources.clear();
    this.ingest.resetCaches();
    this.seenWindows.clear();
  }

  diagnostics(): TtDiagnostics {
    const counts = this.ctx.repo.db.prepare('SELECT (SELECT COUNT(*) FROM chats) AS chats, (SELECT COUNT(*) FROM messages) AS messages').get() as {
      chats: number;
      messages: number;
    };
    return {
      state: this.state,
      ...(this.detail ? { detail: this.detail } : {}),
      watcher: this.watcher?.diagnostics() ?? { frames: 0, bodies: 0, lastFrameAt: null, sockets: 0, recentPaths: [] },
      chats: counts.chats,
      messages: counts.messages,
      meId: this.ingest.me?.id ?? null,
    };
  }

  async probePage(): Promise<PageProbe | null> {
    const a = this.agentRef;
    if (!a) return null;
    return this.run(() => a.probe());
  }

  retryMedia(messageId: string): boolean {
    const row = this.ctx.repo.findMessage(messageId);
    if (!row || row.media_status === 'none' || row.media_status === 'downloaded') return false;
    this.ctx.repo.updateMessage(row.id, { media_status: 'pending', media_attempts: 0, updated_at: Date.now() });
    this.media.enqueue(row.id, 'live');
    return true;
  }

  /* -------------------------------------------------------------- connecting */

  private scheduleConnect(delayMs: number): void {
    if (this.stopped) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.connect(false);
    }, delayMs);
    t.unref();
    this.timers.add(t);
  }

  private async connect(fresh: boolean): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    const gen = ++this.gen;
    try {
      if (!this.ctx.config.ttEnabled) {
        this.setState('idle', 'The TikTok connection is disabled (TT_ENABLED=false).');
        return;
      }
      this.setState('starting');
      const origin = this.ctx.config.ttWebOrigin;
      let browser: Browser;
      let page: Page;
      if (this.connectHook) {
        ({ browser, page } = await this.connectHook(this.chromium));
      } else {
        if (!(await this.chromium.ensure())) throw new Error('Chromium is not reachable yet');
        if (gen !== this.gen || this.stopped) return;
        const opts = await this.chromium.connectOptions();
        browser = await puppeteer.connect({ ...opts, defaultViewport: null, protocolTimeout: 60_000 });
        this.weConnected = true;
        page = await pickTikTokTab(browser, origin);
      }
      this.browser = browser;
      browser.on('disconnected', () => {
        if (gen === this.gen) this.lost('The browser connection was lost.');
      });
      this.page = page;
      page.on('error', () => this.lost('The TikTok tab crashed.'));
      const startUrl = `${origin}/messages`;
      if (!page.url().startsWith(origin)) await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
      this.attempt = 0;
      if (this.connectHook) {
        // A browser handed in by a test is already open on the (fake) messages page: skip the login watcher, which
        // talks to the chromium manager's HTTP endpoints.
        await this.goReady(gen);
      } else {
        this.loginLoop(gen, fresh);
      }
    } catch (err) {
      this.lost(err instanceof Error ? err.message : 'the browser is not reachable');
    } finally {
      this.connecting = false;
    }
  }

  private lost(reason: string): void {
    this.attempt++;
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(this.attempt, 5));
    this.setState('error', `${reason} Retrying in ${Math.round(delay / 1000)}s.`);
    this.ctx.log.warn({ reason, attempt: this.attempt }, 'tiktok connection lost');
    this.scheduleConnect(delay);
  }

  /**
   * While logged out, nothing is attached to the tab: a debugger in the page is exactly what TikTok's bot checks look
   * for. The tab list and the cookie jar are read over a browser-level connection instead.
   */
  private loginLoop(gen: number, fresh: boolean, strayPolls = 0): void {
    if (gen !== this.gen || this.stopped) return;
    const target = this.chromium.cdpTarget();
    const origin = this.ctx.config.ttWebOrigin;
    void lookAtTab(target, origin)
      .then(async (look) => {
        if (gen !== this.gen || this.stopped) return;
        const step = nextLoginStep(look, { fresh, strayPolls });
        if (step === 'attach') {
          this.setState('starting', 'Logged in. Connecting to the messages page…');
          await this.goReady(gen);
          return;
        }
        if (look.kind === 'challenge') this.setState('challenge', 'TikTok asks for a check. Answer it on the TikTok screen.');
        else if (step === 'open_login') {
          this.setState('login', 'Log in to TikTok on the TikTok screen (or paste a session).');
          await steerTab(target, look.tab, { goto: `${origin}/login` }).catch(() => undefined);
        } else if (step === 'reload') {
          await steerTab(target, look.tab, { reload: true }).catch(() => undefined);
        } else if (this.state !== 'login' && this.state !== 'challenge') {
          this.setState(look.loggedIn ? 'starting' : 'login');
        }
        const t = setTimeout(() => {
          this.timers.delete(t);
          this.loginLoop(gen, false, look.kind === 'other' ? strayPolls + 1 : 0);
        }, 3000);
        t.unref();
        this.timers.add(t);
      })
      .catch(() => {
        this.lost('The browser did not answer');
      });
  }

  private async goReady(gen: number): Promise<void> {
    const page = this.page;
    if (!page || gen !== this.gen) return;
    const origin = this.ctx.config.ttWebOrigin;
    await closeOtherTabs(this.browser!, page);
    await page.bringToFront().catch(() => undefined);
    // The feed lives in another window: this page must keep believing it has the focus (typing, composer blur handlers).
    await page.emulateFocusedPage(true).catch(() => undefined);

    const agent = new DomAgent(page, this.selectors);
    await agent.install();
    this.agentRef = agent;
    const downloader = new BrowserDownloader(page, true, origin === 'https://www.tiktok.com' ? undefined : origin);
    await downloader.attach().catch(() => undefined);
    this.downloaderRef = downloader;
    this.watcher = new Watcher(
      page,
      {
        frame: (f) => this.onFrame(f.bytes, f.dir),
        body: (b) => this.onBody(b.body, b.contentType),
        // The For You page's own JSON: item ids and the signed video URLs the DOM does not expose.
        feed: (b) => this.feedCatalog.ingest(b.body),
        navigated: (url) => this.onNavigated(url),
      },
      origin === 'https://www.tiktok.com' ? null : origin,
    );
    await this.watcher.attach().catch(() => undefined);
    // A fresh load of the messages page makes TikTok send the conversation list and the open conversation again —
    // now through our watcher, so those answers (server ids, senders) are captured before the import reads the page.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    await sleep(2000);
    await agent.reset().catch(() => undefined);

    // Who am I: the page first, the cookie jar as a fallback.
    const me = await agent.me().catch(() => null);
    const uid = me?.id ?? (this.connectHook ? null : ((await lookAtTab(this.chromium.cdpTarget(), origin).catch(() => null))?.userId ?? null));
    if (uid) {
      this.ingest.me = { id: uid, username: me?.username ?? null, name: me?.name ?? null };
      this.ingest.upsertContact({ id: uid, username: me?.username ?? null, name: me?.name ?? null }, true);
      this.me = { id: uid, username: me?.username ?? null, name: me?.name ?? null };
    }

    if (page.url() !== `${origin}/messages` && classifyUrl(page.url(), origin) !== 'messages') {
      await page.goto(`${origin}/messages`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    }
    await sleep(1500);
    this.setState('syncing', 'Importing conversations…');
    this.syncInfo = { phase: 'history', chatsDone: 0, chatsTotal: 0 };
    this.media.resume();
    this.media.restorePending();
    const engine = await this.startEngine(page);
    if (engine) {
      try {
        await engine.initialImport((done, total) => {
          this.syncInfo = { phase: 'history', chatsDone: done, chatsTotal: total };
          this.ctx.events.emit({ type: 'sync_progress', sync: this.syncInfo });
        });
        this.ctx.repo.setState('initial_sync_done', '1');
      } catch (err) {
        this.ctx.log.warn({ err: (err as Error).message }, 'initial import failed (continuing)');
      }
      this.syncInfo = null;
      this.setState('ready');
      this.startProtocolLoops(gen, engine);
      return;
    }
    try {
      this.sync.useAgent(agent);
      await this.sync.initial();
      this.ctx.repo.setState('initial_sync_done', '1');
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, 'initial import failed (continuing)');
    }
    this.syncInfo = null;
    this.setState('ready');
    this.startLoops(gen);
  }

  /**
   * Switches to the IM protocol when it answers in this tab (the normal case). Otherwise the page-driving path keeps
   * the log going and the reason is logged.
   */
  private async startEngine(page: Page): Promise<ImEngine | null> {
    // The protocol only exists on the real site (the test double has no IM API).
    if (this.ctx.config.ttWebOrigin !== 'https://www.tiktok.com') return null;
    const transport = new ImTransport({ evaluate: (fn, ...args) => page.evaluate(fn as never, ...(args as unknown as never[])) as never });
    const engine = new ImEngine(this.ctx, this.ingest, transport, { activity: () => (this.lastEventAt = Date.now()) });
    if (!(await engine.probe())) {
      this.ctx.log.warn('TikTok IM protocol unavailable in this tab — using the page-driving fallback');
      return null;
    }
    try {
      const { uid } = await transport.env();
      if (uid && this.ingest.me?.id !== uid) {
        this.ingest.me = { id: uid, username: this.me?.username ?? null, name: this.me?.name ?? null };
        this.ingest.upsertContact(this.ingest.me, true);
        this.me = this.ingest.me;
      }
    } catch {
      /* the page-reported id stays */
    }
    this.engineRef = engine;
    this.webApiRef = new WebApi({ evaluate: (fn, ...args) => page.evaluate(fn as never, ...(args as unknown as never[])) as never });
    this.ctx.log.info('TikTok IM protocol and web API active');
    return engine;
  }

  /** The protocol loops: a cheap catch-up every few seconds, the unsend check every `reconcileMinutes`. */
  private startProtocolLoops(gen: number, engine: ImEngine): void {
    this.stopLoops();
    let failures = 0;
    const poll = async () => {
      if (gen !== this.gen || this.stopped) return;
      try {
        const page = this.page;
        const kind = page ? classifyUrl(page.url(), this.ctx.config.ttWebOrigin) : 'blank';
        if (kind === 'login' || kind === 'challenge') {
          this.setState(kind === 'login' ? 'login' : 'challenge', 'TikTok is logged out. Log in on the TikTok screen.');
        } else {
          await engine.catchUp('live', 6);
          failures = 0;
          this.lastPollAt = Date.now();
          if (this.state !== 'ready') this.setState('ready');
        }
      } catch (err) {
        failures++;
        this.ctx.log.debug({ err: (err as Error).message, failures }, 'catch-up failed');
        // A page that was reloaded or navigated loses its device id for a moment: forget it and ask again.
        if (failures === 3) void this.reloadTab();
      }
      if (gen !== this.gen || this.stopped) return;
      this.pollTimer = setTimeout(() => void poll(), failures ? Math.min(30_000, 4000 * failures) : 5000);
      this.pollTimer.unref();
    };
    this.pollTimer = setTimeout(() => void poll(), 3000);
    this.pollTimer.unref();

    const reconcile = async () => {
      if (gen !== this.gen || this.stopped) return;
      this.syncInfo = { phase: 'reconcile', chatsDone: 0, chatsTotal: 0 };
      this.ctx.events.emit({ type: 'sync_progress', sync: this.syncInfo });
      try {
        await engine.reconcile(15);
      } catch (err) {
        this.ctx.log.warn({ err: (err as Error).message }, 'reconcile failed');
      } finally {
        this.syncInfo = null;
        this.ctx.events.emit({ type: 'sync_progress', sync: null });
      }
      if (gen !== this.gen || this.stopped) return;
      this.reconcileTimer = setTimeout(() => void reconcile(), this.ctx.settings.get().reconcileMinutes * 60_000);
      this.reconcileTimer.unref();
    };
    this.reconcileTimer = setTimeout(() => void reconcile(), 60_000);
    this.reconcileTimer.unref();
    this.scheduleRefresh(gen);
  }

  private startLoops(gen: number): void {
    this.stopLoops();
    const poll = async () => {
      if (gen !== this.gen || this.stopped) return;
      try {
        await this.pollOnce();
      } catch (err) {
        this.ctx.log.debug({ err: (err as Error).message }, 'poll failed');
      }
      if (gen !== this.gen || this.stopped) return;
      this.pollTimer = setTimeout(() => void poll(), 2500);
      this.pollTimer.unref();
    };
    void poll();

    const reconcile = async () => {
      if (gen !== this.gen || this.stopped) return;
      await this.reconcileOnce().catch((err: unknown) => this.ctx.log.warn({ err: (err as Error).message }, 'reconcile failed'));
      if (gen !== this.gen || this.stopped) return;
      const minutes = this.ctx.settings.get().reconcileMinutes;
      this.reconcileTimer = setTimeout(() => void reconcile(), minutes * 60_000);
      this.reconcileTimer.unref();
    };
    this.reconcileTimer = setTimeout(() => void reconcile(), 90_000);
    this.reconcileTimer.unref();

    this.scheduleRefresh(gen);
  }

  private stopLoops(): void {
    for (const t of [this.pollTimer, this.reconcileTimer, this.refreshTimer]) t?.unref();
    this.pollTimer = null;
    this.reconcileTimer = null;
    this.refreshTimer = null;
  }

  /** Reloads the tab every `sessionRefreshHours` (± jitter) so TikTok keeps the session fresh. */
  private scheduleRefresh(gen: number): void {
    const s = this.ctx.settings.get();
    if (!s.sessionRefresh) return;
    const jitter = (Math.random() - 0.5) * 2 * 20 * 60_000;
    const delay = Math.max(10 * 60_000, s.sessionRefreshHours * 3600_000 + jitter);
    this.refreshTimer = setTimeout(() => {
      if (gen !== this.gen || this.stopped) return;
      void this.reloadTab().finally(() => this.scheduleRefresh(gen));
    }, delay);
    this.refreshTimer.unref();
  }

  private async reloadTab(): Promise<void> {
    this.ctx.log.info('refreshing the TikTok tab');
    await this.run(async () => {
      const page = this.page;
      if (!page) return;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
      await sleep(2500);
      await this.agentRef?.reset().catch(() => undefined);
      this.pendingReconcile = true;
      // The reloaded document brings a fresh device id and token: the protocol side reads them again.
      this.engineRef?.forgetEnv();
    });
  }

  private async teardown(): Promise<void> {
    this.gen++;
    this.stopLoops();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.media.pause();
    await this.pageFeed.reset().catch(() => undefined);
    const feedPage = this.feedPageRef;
    this.feedPageRef = null;
    await this.feedWatcher?.detach().catch(() => undefined);
    this.feedWatcher = null;
    if (feedPage && !feedPage.isClosed()) await feedPage.close().catch(() => undefined);
    this.engineRef?.flush();
    this.engineRef = null;
    this.webApiRef = null;
    this.apiFeed.reset();
    await this.run(async () => {
      await this.watcher?.detach().catch(() => undefined);
      await this.downloaderRef?.detach().catch(() => undefined);
      this.watcher = null;
      this.downloaderRef = null;
      this.agentRef = null;
      if (this.weConnected) {
        try {
          this.browser?.disconnect();
        } catch {
          /* already gone */
        }
      }
      this.browser = null;
      this.page = null;
    }).catch(() => undefined);
    this.openChatId = null;
  }

  private async clearCookies(): Promise<void> {
    const target = this.chromium.cdpTarget();
    const { BrowserCdp } = await import('./loginwatch.js');
    const cdp = await BrowserCdp.open(target);
    try {
      await cdp.send('Storage.clearCookies', {});
    } finally {
      cdp.close();
    }
  }

  /* ------------------------------------------------------------------- loops */

  private async pollOnce(): Promise<void> {
    const agent = this.agentRef;
    if (!agent || this.state !== 'ready') return;
    const page = this.page;
    if (!page) return;
    const url = page.url();
    const origin = this.ctx.config.ttWebOrigin;
    const kind = classifyUrl(url, origin);
    if (kind === 'login' || kind === 'challenge') {
      this.setState(kind === 'login' ? 'login' : 'challenge', 'TikTok is logged out. Log in on the TikTok screen.');
      return;
    }
    if (Date.now() - this.lastThreadListAt > 15_000) {
      this.lastThreadListAt = Date.now();
      await this.readThreads().catch(() => undefined);
    }
    // The open conversation: read it a few seconds at a time.
    const snap = await this.snapshot().catch(() => null);
    if (snap && snap.threadId) {
      this.openChatId = this.chatKeyFor(snap.threadId) ?? snap.threadId;
      this.trackSeen(this.openChatId, snap, this.ingestSnapshot(this.openChatId, snap, 'dom'));
      this.lastPollAt = Date.now();
    }
    if (this.pendingReconcile) {
      this.pendingReconcile = false;
      void this.reconcileOnce().catch(() => undefined);
    }
  }

  /** Health: nothing at all from TikTok for 20 minutes while ready → reload the tab and re-read. */
  private async reconcileOnce(): Promise<void> {
    if (this.state !== 'ready' || this.stopped) return;
    const last = Math.max(this.watcher?.lastFrameAt ?? 0, this.lastPollAt);
    if (last && Date.now() - last > 20 * 60_000) await this.reloadTab();
    this.syncInfo = { phase: 'reconcile', chatsDone: 0, chatsTotal: 0 };
    this.ctx.events.emit({ type: 'sync_progress', sync: this.syncInfo });
    try {
      await this.sync.reconcile();
    } finally {
      this.syncInfo = null;
    }
    if (this.openChatId) await this.ensureChatOpen(this.openChatId).catch(() => undefined);
  }

  /* ---------------------------------------------------------------- capture */

  private onFrame(bytes: Buffer, dir: 'in' | 'out' = 'in'): void {
    const engine = this.engineRef;
    if (engine) {
      if (dir === 'in' && engine.handleFrame(bytes)) this.lastEventAt = engine.lastEventAt ?? this.lastEventAt;
      return;
    }
    this.handleCandidates(bytes, null, 'live');
  }

  private onBody(bytes: Buffer, contentType: string): void {
    // With the protocol engine the answers are our own requests', read directly: the schema-less reader must not
    // store them a second time.
    if (this.engineRef) return;
    this.handleCandidates(bytes, contentType, 'history');
  }

  private onNavigated(url: string): void {
    this.ctx.log.debug({ path: safePath(url) }, 'tab navigated');
    this.lastThreadListAt = 0;
    this.lastPollAt = Date.now();
  }

  /** One decoded network payload: conversations and messages are stored, everything else is ignored. */
  private handleCandidates(bytes: Buffer, contentType: string | null, source: 'live' | 'history'): void {
    if (!this.ctx.writer()) return;
    let read;
    try {
      read = contentType === null ? readFrameSafe(bytes) : readBodySafe(bytes, contentType);
    } catch {
      return;
    }
    if (!read.json.length) return;
    // "Who am I" often arrives in the same answers (a `me`/`userInfo` object): it lets own messages be recognised.
    for (const root of read.json) {
      const meObj = pickMe(root);
      if (meObj && this.ingest.me?.id !== meObj.id) {
        this.ingest.me = { id: meObj.id, username: meObj.username ?? null, name: meObj.name ?? null };
        this.me = this.ingest.me;
        this.ingest.upsertContact(meObj, true);
      }
    }
    let stored = 0;
    for (const root of read.json) {
      for (const obj of walkCandidates(root)) {
        const thread = mapThread(obj, { meId: this.ingest.me?.id ?? null });
        if (thread) {
          this.ingestThread(thread);
          stored++;
        }
        const msg = mapMessage(obj, null, { meId: this.ingest.me?.id ?? null });
        if (msg) {
          this.ingest.message(msg, source);
          stored++;
        }
      }
    }
    if (stored) this.lastEventAt = Date.now();
  }

  private ingestThread(t: TtThread): void {
    if (!t.id) return;
    if (t.name && (t.id === t.name || !isOpaqueId(t.id))) this.ctx.log.warn({ id: t.id.slice(0, 40) }, 'thread without a usable id');
    if (t.name || t.peerId) this.chatKeys.set(t.id, t.peerId ?? t.name!);
    this.ingest.thread(t);
    this.ctx.events.emit({ type: 'chat_update', chatId: t.id });
  }

  /**
   * A snapshot belongs to [chatId] only when the page really is on that conversation. Reading chat B while the page
   * sits on chat A would store A's messages under B and then report B's messages as deleted, so a mismatched read is
   * dropped instead.
   */
  private snapshotIsFor(chatId: string, snap: ThreadSnapshot): boolean {
    if (!snap.threadId) return false;
    return this.chatKeyFor(snap.threadId) === chatId || snap.threadId === chatId;
  }

  /** The sync read a conversation: store it, and on a re-check also look for messages that vanished. */
  private afterChat(chatId: string, snap: ThreadSnapshot, phase: 'history' | 'reconcile'): void {
    if (!this.snapshotIsFor(chatId, snap)) {
      this.ctx.log.debug({ chat: maskId(chatId) }, 'read skipped: the page is on another conversation');
      return;
    }
    const stored = this.ingestSnapshot(chatId, snap, phase);
    this.trackSeen(chatId, snap, stored);
    if (phase === 'reconcile') this.judgeMissing(chatId, snap);
  }

  /** Maps the rows of a snapshot for [chatId], filling in timestamps the page did not show. */
  mapRows(chatId: string, snap: ThreadSnapshot): TtMessage[] {
    const ctx = { meId: this.ingest.me?.id ?? null, now: snap.at };
    const out: TtMessage[] = [];
    let last = 0;
    const rows = snap.rows;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const m = domRowToMessage(chatId, row, ctx);
      if (!m) continue;
      if (!row.ts) {
        // No time on the row: keep the reading order by spacing them a minute apart, ending "now".
        const back = rows.length - 1 - i;
        m.ts = Math.max(last + 1000, snap.at - back * 60_000);
      }
      last = Math.max(last, m.ts);
      out.push(m);
    }
    return out;
  }

  /** Stores the rows of a snapshot; returns the ids the database actually uses (they can differ from the page's). */
  private ingestSnapshot(chatId: string, snap: ThreadSnapshot, source: 'dom' | 'history' | 'reconcile'): Set<string> {
    const stored = new Set<string>();
    for (const m of this.mapRows(chatId, snap)) {
      const id = this.ingest.message(m, source === 'dom' ? 'dom' : 'history');
      if (id) stored.add(id);
    }
    if (snap.rows.length) this.lastEventAt = Date.now();
    return stored;
  }

  /** Remembers what the latest read of a conversation showed (ids and the time range it covered). */
  private trackSeen(chatId: string, snap: ThreadSnapshot, stored: Set<string>): void {
    const times = snap.rows.map((r) => r.ts).filter((t): t is number => typeof t === 'number');
    const now = Date.now();
    this.seenWindows.set(chatId, {
      from: times.length ? Math.min(...times) : now - 15 * 60_000,
      to: times.length ? Math.max(...times) : now,
      ids: new Set(stored),
    });
  }

  /** Compares what the page shows with what was stored: messages that vanished were deleted by the sender. */
  private judgeMissing(chatId: string, snap: ThreadSnapshot): void {
    const win = this.seenWindows.get(chatId);
    if (!win) return;
    if (!this.snapshotIsFor(chatId, snap)) return;
    const times = snap.rows.map((r) => r.ts).filter((t): t is number => typeof t === 'number');
    if (times.length < 2) return;
    // A read that starts later than the previous one only saw part of the conversation (TikTok renders the list in
    // pieces, and a conversation just opened can still be filling in). Judging deletions against a partial read marks
    // messages the sender never touched as unsent, so this pass is skipped unless the read reaches back as far as the
    // previous one did.
    if (Math.min(...times) > win.from + 120_000) return;
    // Only what this read covered is judged: stored messages in that range that the read no longer shows.
    this.ingest.markMissing(chatId, win.ids, Math.min(...times), Math.max(...times));
  }

  /* ------------------------------------------------------------- page access */

  /**
   * The tab the feed is browsed in. Separate from the messages tab on purpose: the messages tab must stay on the
   * inbox to keep the log complete (and to keep TikTok's stream socket alive there).
   */
  async feedPage(): Promise<{ page: Page; origin: string } | null> {
    if (this.state !== 'ready' || !this.browser) return null;
    const origin = this.ctx.config.ttWebOrigin;
    const existing = this.feedPageRef;
    if (existing && !existing.isClosed()) return { page: existing, origin };
    // Its own window, not a second tab: in one window the tab that is not in front is `hidden`, and a hidden tab never
    // acknowledges key events — typing a message while the feed was open hung until the feed was closed.
    const page = await this.browser.newPage({ type: 'window' });
    this.feedPageRef = page;
    await page.emulateFocusedPage(true).catch(() => undefined);
    page.on('close', () => {
      if (this.feedPageRef === page) this.feedPageRef = null;
    });
    // The feed tab is its own document: the messages tab's watcher cannot see its responses, so give it one that only
    // collects the item list (ids + signed video URLs).
    const feedWatcher = new Watcher(
      page,
      {
        frame: () => undefined,
        body: () => undefined,
        navigated: () => undefined,
        feed: (b) => this.feedCatalog.ingest(b.body),
      },
      origin === 'https://www.tiktok.com' ? null : origin,
    );
    await feedWatcher.attach().catch(() => undefined);
    this.feedWatcher = feedWatcher;
    await page.goto(`${origin}/foryou`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    return { page, origin };
  }

  agent(): DomAgent {
    const a = this.agentRef;
    if (!a) throw Errors.unavailable('TikTok is not connected.');
    return a;
  }

  protocol(): ImEngine | null {
    return this.engineRef;
  }

  async snapshot(): Promise<ThreadSnapshot | null> {
    const a = this.agentRef;
    if (!a || !this.page) return null;
    return this.run(() => a.messages());
  }

  async readThreads(): Promise<TtThread[]> {
    const a = this.agentRef;
    if (!a) return [];
    const rows = await this.run(() => a.threads());
    const out: TtThread[] = [];
    for (const r of rows) {
      const t = domThreadToThread(r, { meId: this.ingest.me?.id ?? null });
      if (!t) continue;
      this.ingestThread(t);
      if (t.name) this.chatKeys.set(t.id, t.name);
      out.push(t);
    }
    return out;
  }

  async ensureChatOpen(chatId: string): Promise<void> {
    const a = this.agentRef;
    if (!a) throw Errors.unavailable('TikTok is not connected.');
    if (this.openChatId === chatId) {
      const snap = await this.snapshot().catch(() => null);
      if (snap && this.chatKeyFor(snap.threadId) === chatId) return;
    }
    // Try the id first (exact, and the same key the chat list was built from), then the stored name. Using only the
    // name broke as soon as a row's first line differed from what was stored (renamed chats, group sender names).
    const name = this.chatKeys.get(chatId) ?? null;
    const keys = name && name !== chatId ? [chatId, name] : [chatId];
    let opened = false;
    for (const key of keys) {
      const res = await this.run(() => a.openThread(key));
      if (res.ok) {
        opened = true;
        break;
      }
    }
    if (!opened) throw new AppError(409, 'chat_closed', 'That conversation could not be opened in TikTok. Open it once on the TikTok screen, then try again.');
    this.ctx.repo.bumpChatTs(chatId, 0, Date.now());
    // Wait for TikTok to render the conversation (it also marks it read).
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const snap = await this.snapshot().catch(() => null);
      if (snap?.threadId) {
        this.openChatId = this.chatKeyFor(snap.threadId) ?? chatId;
        if (this.openChatId === chatId) return;
      }
    }
    throw new AppError(504, 'chat_timeout', 'TikTok did not open the conversation in time. Try again.');
  }

  /** Used by the media queue: a fresh DOM read of the conversation usually brings fresh signed links. */
  private async refreshMessage(_messageId: string, chatId: string): Promise<void> {
    if (this.engineRef) {
      await this.engineRef.refreshConversation(chatId).catch(() => undefined);
      return;
    }
    await this.ensureChatOpen(chatId).catch(() => undefined);
    const snap = await this.snapshot().catch(() => null);
    if (snap?.rows.length) this.ingestSnapshot(chatId, snap, 'history');
  }

  private chatKeyFor(threadId: string | null): string | null {
    if (!threadId) return null;
    if (this.chatKeys.has(threadId)) return threadId;
    for (const [id, key] of this.chatKeys) if (key === threadId) return id;
    return threadId;
  }

  /* ------------------------------------------------------------------ http */

  /** Serializes everything that touches the page (one puppeteer page, one long-running operation at a time). */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A `me` / `userInfo` / `currentUser` object in an IM answer, if it has a user id. */
function pickMe(root: unknown): TtUser | null {
  if (!root || typeof root !== 'object') return null;
  const r = root as Record<string, unknown>;
  const data = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
  for (const key of ['me', 'userInfo', 'currentUser', 'current_user', 'loginUser']) {
    for (const holder of [data, r]) {
      const v = holder[key];
      if (v && typeof v === 'object') {
        const u = mapUser(v);
        if (u) return u;
      }
    }
  }
  return null;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

import { readBody as readBodyRaw, readFrame as readFrameRaw } from './frames.js';
const readFrameSafe = (b: Buffer) => readFrameRaw(b);
const readBodySafe = (b: Buffer, ct: string) => readBodyRaw(b, ct);
export { DEFAULT_SELECTORS };
export type { SendMediaKind, SendResult };
export { maskId };

/**
 * Picks the feed per call: the web API one while it is active; reads fall back to the page-driving one when the API
 * fails (writes never do: a like or comment that may have gone through must not be repeated another way).
 */
function routedFeed(api: () => ApiFeed | null, page: FeedService): TtFeed {
  const read = <T>(call: (f: TtFeed) => Promise<T>): Promise<T> => {
    const a = api();
    return a ? call(a).catch((e: unknown) => (e instanceof AppError && e.statusCode < 500 ? Promise.reject(e) : call(page))) : call(page);
  };
  const pick = (): TtFeed => api() ?? page;
  return {
    current: () => read((f) => f.current()),
    window: (limit) => read((f) => f.window(limit)),
    goto: (id) => read((f) => f.goto(id)),
    step: (dir) => read((f) => f.step(dir)),
    like: (id, want) => pick().like(id, want),
    comments: (id) => read((f) => f.comments(id)),
    comment: (id, text) => pick().comment(id, text),
    closeComments: () => pick().closeComments(),
    mediaOf: (ref) => api()?.mediaOf(ref).then((r) => r ?? page.mediaOf(ref)) ?? page.mediaOf(ref),
    mediaCached: (ref) => (api()?.mediaCached(ref) ?? false) || page.mediaCached(ref),
    mediaStats: () => (api() ?? page).mediaStats(),
  };
}
