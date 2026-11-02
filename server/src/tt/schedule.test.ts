import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TtScheduleConfig } from '../../../shared/api.js';
import { createLogger } from '../log.js';
import { phaseLengthMs, ScheduleSchema, TtScheduler } from './schedule.js';
import { makeCtx } from './testutil.js';

const MIN = 60_000;
const base: TtScheduleConfig = { mode: 'scheduled', offMinutes: 240, onMinutes: 20, randomize: false, offJitterMinutes: 30, onJitterMinutes: 5 };

class FakeTt {
  paused = false;
  calls: string[] = [];
  async start() {
    this.calls.push('start');
  }
  async pause() {
    this.paused = true;
    this.calls.push('pause');
  }
  async resume() {
    this.paused = false;
    this.calls.push('resume');
  }
  isPaused() {
    return this.paused;
  }
}

describe('phaseLengthMs', () => {
  it('is exact without randomizing', () => {
    expect(phaseLengthMs(240, 30, false, () => 0.9)).toBe(240 * MIN);
  });
  it('spans base ± jitter when randomizing', () => {
    expect(phaseLengthMs(240, 30, true, () => 0)).toBe(210 * MIN);
    expect(phaseLengthMs(240, 30, true, () => 0.5)).toBe(240 * MIN);
    expect(phaseLengthMs(240, 30, true, () => 0.999999)).toBeGreaterThan(269 * MIN);
    expect(phaseLengthMs(20, 5, true, () => 0)).toBe(15 * MIN);
  });
  it('is never under a minute', () => {
    expect(phaseLengthMs(1, 5, true, () => 0)).toBe(MIN);
  });
});

describe('ScheduleSchema', () => {
  it('accepts a good config and rejects junk', () => {
    expect(ScheduleSchema.safeParse(base).success).toBe(true);
    expect(ScheduleSchema.safeParse({ ...base, mode: 'sometimes' }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ ...base, offMinutes: 0 }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ ...base, onMinutes: 99999 }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ ...base, offMinutes: 1.5 }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  it('needs a jitter shorter than the phase when randomizing', () => {
    expect(ScheduleSchema.safeParse({ ...base, randomize: true, onJitterMinutes: 20 }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ ...base, randomize: true, offJitterMinutes: 240 }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ ...base, randomize: false, onJitterMinutes: 20 }).success).toBe(true);
  });
});

describe('TtScheduler', () => {
  let h: Awaited<ReturnType<typeof makeCtx>>;
  let now = 1_000_000;
  let tt: FakeTt;
  const make = (rand = () => 0.5) => new TtScheduler(h.ctx.repo, tt, createLogger('silent'), () => now, rand);

  beforeEach(async () => {
    h = await makeCtx();
    tt = new FakeTt();
    now = 1_000_000;
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('defaults to always on and just starts TikTok', async () => {
    const s = make();
    await s.start();
    s.stop();
    expect(tt.calls).toEqual(['start']);
    expect(s.view()).toMatchObject({ mode: 'on', phase: 'on', phaseUntil: null });
  });

  it('always off pauses, and on resumes', async () => {
    const s = make();
    await s.set({ ...base, mode: 'off' });
    expect(tt.paused).toBe(true);
    expect(s.view()).toMatchObject({ mode: 'off', phase: 'off' });
    await s.set({ ...base, mode: 'on' });
    expect(tt.paused).toBe(false);
    expect(tt.calls).toEqual(['pause', 'resume']);
  });

  it('cycles on → off → on at the configured lengths', async () => {
    const s = make();
    await s.set(base);
    expect(s.view()).toMatchObject({ phase: 'on', phaseUntil: now + 20 * MIN });
    expect(tt.paused).toBe(false);
    now += 19 * MIN;
    await s.tick();
    expect(tt.paused).toBe(false);
    now += 2 * MIN;
    await s.tick();
    expect(tt.paused).toBe(true);
    expect(s.view()).toMatchObject({ phase: 'off', phaseUntil: now + 240 * MIN });
    now += 240 * MIN;
    await s.tick();
    expect(tt.paused).toBe(false);
    expect(s.view().phase).toBe('on');
  });

  it('randomizes each phase with the injected source', async () => {
    const values = [0, 1, 0.5]; // on: -5 → 15 min; off: +30 → 270 min; on: 0 → 20 min
    let i = 0;
    const s = make(() => (values[i++] ?? 0.5) * 0.999999999);
    await s.set({ ...base, randomize: true });
    expect(s.view().phaseUntil).toBe(now + 15 * MIN);
    now += 15 * MIN;
    await s.tick();
    expect(Math.round((s.view().phaseUntil! - now) / MIN)).toBe(270);
  });

  it('resumes the cycle where it was after a restart', async () => {
    const a = make();
    await a.set(base);
    const until = a.view().phaseUntil;
    const again = new FakeTt();
    const b = new TtScheduler(h.ctx.repo, again, createLogger('silent'), () => now, () => 0.5);
    await b.start();
    b.stop();
    expect(b.view().phaseUntil).toBe(until);
    expect(again.calls).toEqual(['start']);
  });

  it('boots straight into the off phase when that is where it was', async () => {
    const a = make();
    await a.set(base);
    now += 21 * MIN;
    await a.tick();
    const fresh = new FakeTt();
    const b = new TtScheduler(h.ctx.repo, fresh, createLogger('silent'), () => now, () => 0.5);
    await b.start();
    b.stop();
    expect(fresh.calls).toEqual(['pause']);
  });

  it('does nothing before the account exists', async () => {
    h.ctx.repo.db.exec('DELETE FROM owner');
    const s = make();
    await s.start();
    s.stop();
    expect(tt.calls).toEqual([]);
  });

  it('a corrupt saved config falls back to always on', async () => {
    h.ctx.repo.setState('tt_schedule', '{nope');
    expect(make().config().mode).toBe('on');
  });

  it('rejects an invalid config without changing anything', async () => {
    const s = make();
    await expect(s.set({ ...base, offMinutes: 0 })).rejects.toThrow();
    expect(s.config().mode).toBe('on');
  });
});
