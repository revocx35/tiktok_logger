import crypto from 'node:crypto';
import { z } from 'zod';
import type { TtScheduleConfig, TtScheduleView } from '../../../shared/api.js';
import type { Logger } from '../log.js';
import type { Repo } from '../db/repo.js';
import type { TtController } from '../context.js';

/*
 * The admin's TikTok session schedule for one user (one tenant worker owns one schedule).
 *
 *  - 'on'        the session always runs (the default, and what every release before the schedule did)
 *  - 'off'       the session never runs: the logging stops and the tenant's Chromium is shut down (profile kept)
 *  - 'scheduled' off for `offMinutes`, then on for `onMinutes`, forever. With `randomize` each phase lasts its length
 *                ± a random amount up to the jitter, so the pattern does not repeat exactly. The cycle starts with an
 *                "on" phase (so the log is current right after the admin saves it).
 *
 * The config and the running phase live in the tenant's own database (app_state) so a restart or a deploy resumes
 * where the cycle was instead of starting over. Phases are re-evaluated every TICK_MS and once at boot.
 */

export const MAX_MINUTES = 7 * 24 * 60;
const CONFIG_KEY = 'tt_schedule';
const PHASE_KEY = 'tt_schedule_phase';
const TICK_MS = 15_000;
const MIN_PHASE_MS = 60_000;

export const DEFAULT_SCHEDULE: TtScheduleConfig = {
  mode: 'on',
  offMinutes: 240,
  onMinutes: 20,
  randomize: false,
  offJitterMinutes: 30,
  onJitterMinutes: 5,
};

const Minutes = z.number().int().min(1).max(MAX_MINUTES);
const Jitter = z.number().int().min(0).max(MAX_MINUTES);

export const ScheduleSchema = z
  .object({
    mode: z.enum(['on', 'off', 'scheduled']),
    offMinutes: Minutes,
    onMinutes: Minutes,
    randomize: z.boolean(),
    offJitterMinutes: Jitter,
    onJitterMinutes: Jitter,
  })
  .strict()
  .superRefine((c, ctx) => {
    // A jitter as long as the phase itself could make it zero-length: keep at least one minute of the base.
    if (c.randomize && c.offJitterMinutes >= c.offMinutes) ctx.addIssue({ code: 'custom', path: ['offJitterMinutes'], message: 'The random range must be shorter than the off time.' });
    if (c.randomize && c.onJitterMinutes >= c.onMinutes) ctx.addIssue({ code: 'custom', path: ['onJitterMinutes'], message: 'The random range must be shorter than the on time.' });
  });

interface Phase {
  phase: 'on' | 'off';
  until: number;
}

/** Length of one phase in ms: the base, or base ± up to the jitter (uniform), never under a minute. */
export function phaseLengthMs(baseMinutes: number, jitterMinutes: number, randomize: boolean, rand: () => number): number {
  const jitter = randomize ? (rand() * 2 - 1) * jitterMinutes : 0;
  return Math.max(MIN_PHASE_MS, Math.round((baseMinutes + jitter) * 60_000));
}

/** Uniform [0, 1) from the OS random source (the pattern must not be guessable from a seeded PRNG). */
export function secureRandom(): number {
  return crypto.randomInt(0, 2 ** 31) / 2 ** 31;
}

export class TtScheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private readonly repo: Repo,
    private readonly tt: Pick<TtController, 'start' | 'pause' | 'resume' | 'isPaused'>,
    private readonly log: Logger,
    private readonly clock: () => number = Date.now,
    private readonly rand: () => number = secureRandom,
  ) {}

  config(): TtScheduleConfig {
    const raw = this.repo.getState(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_SCHEDULE };
    try {
      const parsed = ScheduleSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through */
    }
    return { ...DEFAULT_SCHEDULE };
  }

  private phase(): Phase | null {
    const raw = this.repo.getState(PHASE_KEY);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as Partial<Phase>;
      if ((p.phase === 'on' || p.phase === 'off') && typeof p.until === 'number' && Number.isFinite(p.until)) return { phase: p.phase, until: p.until };
    } catch {
      /* fall through */
    }
    return null;
  }

  view(): TtScheduleView {
    const c = this.config();
    if (c.mode === 'on') return { ...c, phase: 'on', phaseUntil: null };
    if (c.mode === 'off') return { ...c, phase: 'off', phaseUntil: null };
    const p = this.phase();
    return { ...c, phase: p?.phase ?? 'on', phaseUntil: p?.until ?? null };
  }

  /** Saves a new schedule and applies it now. A scheduled cycle starts over with an "on" phase. */
  async set(next: TtScheduleConfig): Promise<TtScheduleView> {
    const c = ScheduleSchema.parse(next);
    this.repo.setState(CONFIG_KEY, JSON.stringify(c));
    this.repo.deleteState(PHASE_KEY);
    await this.tick();
    return this.view();
  }

  /** Called once at boot: applies the saved schedule (starting TikTok unless it should be off) and begins ticking. */
  async start(): Promise<void> {
    await this.tick();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One evaluation; calls never overlap (a pause/resume takes seconds). */
  tick(): Promise<void> {
    this.busy = this.busy.then(() => this.evaluate()).catch((err: unknown) => {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'session schedule step failed');
    });
    return this.busy;
  }

  private async evaluate(): Promise<void> {
    if (!this.repo.hasOwner()) return; // nothing to run before the account exists (the claim starts TikTok itself)
    const c = this.config();
    let want: 'on' | 'off';
    if (c.mode === 'scheduled') want = this.advance(c).phase;
    else want = c.mode;
    if (want === 'off' && !this.tt.isPaused()) {
      this.log.info('session schedule: switching the TikTok session off');
      await this.tt.pause();
    } else if (want === 'on' && this.tt.isPaused()) {
      this.log.info('session schedule: switching the TikTok session on');
      await this.tt.resume();
    } else if (want === 'on') {
      await this.tt.start(); // idempotent; also the first start after boot
    }
  }

  /** Moves the cycle forward: at most one flip per call, timed from now (a long downtime does not replay missed phases). */
  private advance(c: TtScheduleConfig): Phase {
    const now = this.clock();
    let p = this.phase();
    if (!p) {
      p = { phase: 'on', until: now + phaseLengthMs(c.onMinutes, c.onJitterMinutes, c.randomize, this.rand) };
    } else if (now >= p.until) {
      const nextPhase = p.phase === 'on' ? 'off' : 'on';
      const len = nextPhase === 'on' ? phaseLengthMs(c.onMinutes, c.onJitterMinutes, c.randomize, this.rand) : phaseLengthMs(c.offMinutes, c.offJitterMinutes, c.randomize, this.rand);
      p = { phase: nextPhase, until: now + len };
    } else {
      return p;
    }
    this.repo.setState(PHASE_KEY, JSON.stringify(p));
    return p;
  }
}
