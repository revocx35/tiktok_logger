import type { AppContext } from '../context.js';
import type { ThreadSnapshot, TtThread } from './types.js';

/**
 * Reading conversations: the initial import and the periodic re-check.
 *
 * Both walk the conversation list and open one conversation after another — which is also what marks them seen on
 * TikTok, so this is the only way to read history from the outside. `TT_REQUEST_GAP_MS` (default 1.5 s) between
 * conversations keeps the traffic human-like; nothing here retries in a tight loop.
 */

export interface SyncDeps {
  threads(): Promise<TtThread[]>;
  openChat(chatId: string): Promise<void>;
  snapshot(): Promise<ThreadSnapshot | null>;
  /** Called for each conversation read: the service stores the rows and (for a re-check) looks for deletions. */
  afterChat(chatId: string, snap: ThreadSnapshot, phase: 'history' | 'reconcile'): void;
  progress(phase: 'history' | 'reconcile', done: number, total: number): void;
}

const INITIAL_CHATS = 40;
const RECONCILE_CHATS = 15;
const SCROLLS = 4;

export class Sync {
  constructor(
    private readonly ctx: AppContext,
    private readonly deps: SyncDeps,
  ) {}

  private get gapMs(): number {
    return this.ctx.config.ttRequestGapMs;
  }

  /** First import: the newest conversations, each read down to `historyPerChat` messages (a few scroll-ups). */
  /**
   * The conversation list renders late and in pieces: reading it the moment the page opens returns one or two rows.
   * Wait until the count stops growing (two equal reads, 12 s at most) before importing, or conversations are missed.
   */
  private async settledThreads(): Promise<TtThread[]> {
    let last: TtThread[] = [];
    for (let i = 0; i < 8; i++) {
      const now = await this.deps.threads();
      if (now.length && now.length === last.length) return now;
      if (now.length > last.length) last = now;
      if (i > 0 || now.length) await sleep(1200);
    }
    return last;
  }

  async initial(): Promise<void> {
    const threads = await this.settledThreads();
    const perChat = this.ctx.settings.get().historyPerChat;
    const chats = threads.slice(0, INITIAL_CHATS);
    this.deps.progress('history', 0, chats.length);
    let done = 0;
    for (const t of chats) {
      await this.readChat(t.id, perChat, 'history');
      done++;
      this.deps.progress('history', done, chats.length);
      await sleep(this.gapMs);
    }
    this.ctx.log.info({ chats: done }, 'initial import finished');
  }

  /** Re-read the newest conversations (and the ones with unread messages) to notice unsent messages. */
  async reconcile(): Promise<void> {
    const threads = await this.settledThreads();
    const chosen = new Map<string, TtThread>();
    for (const t of threads.slice(0, 10)) chosen.set(t.id, t);
    for (const t of threads) if ((t.unread ?? 0) > 0 && chosen.size < RECONCILE_CHATS) chosen.set(t.id, t);
    const list = [...chosen.values()].slice(0, RECONCILE_CHATS);
    this.deps.progress('reconcile', 0, list.length);
    let done = 0;
    for (const t of list) {
      await this.readChat(t.id, Math.max(60, Math.min(200, this.ctx.settings.get().historyPerChat)), 'reconcile');
      done++;
      this.deps.progress('reconcile', done, list.length);
      await sleep(this.gapMs);
    }
  }

  private async readChat(chatId: string, want: number, phase: 'history' | 'reconcile'): Promise<void> {
    try {
      await this.deps.openChat(chatId);
      let snap = await this.deps.snapshot();
      if (!snap) return;
      let rows = snap.rows.length;
      for (let i = 0; i < SCROLLS && rows < want; i++) {
        const agent = this.agent();
        if (!agent) break;
        await agent.scroll('top');
        await sleep(1200);
        const next = await this.deps.snapshot();
        if (!next) break;
        snap = next;
        if (next.rows.length <= rows) break; // nothing older came in
        rows = next.rows.length;
      }
      this.deps.afterChat(chatId, snap, phase);
    } catch (err) {
      this.ctx.log.debug({ err: (err as Error).message, chat: chatId.slice(0, 8) }, 'reading a conversation failed');
    }
  }

  private agent(): { scroll(dir: 'top' | 'bottom'): Promise<boolean> } | null {
    return this.scrollTarget;
  }

  private scrollTarget: { scroll(dir: 'top' | 'bottom'): Promise<boolean> } | null = null;

  /** The service hands its page agent over here (kept separate so `Sync` stays testable). */
  useAgent(agent: { scroll(dir: 'top' | 'bottom'): Promise<boolean> } | null): void {
    this.scrollTarget = agent;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
