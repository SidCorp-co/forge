import { describe, expect, it } from 'vitest';
import {
  type CycleSample,
  concurrencyOf,
  type History,
  percentile,
  runForecast,
  scopeForecast,
  type Wait,
  type WorkItem,
} from './model.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const MINUTE = 60_000;

/** `n` landings spread evenly over minutes 45..75 (p50 60), one a day apart: Little's L < 1. */
function history(n: number, span = n): History {
  const samples: CycleSample[] = Array.from({ length: n }, (_, i) => ({
    minutes: 45 + Math.round((30 * i) / Math.max(1, n - 1)),
    complexity: null,
  }));
  return { samples, spanDays: span, peak: null };
}

let seq = 0;
function item(over: Partial<WorkItem> = {}): WorkItem {
  seq += 1;
  return {
    id: `id-${seq}`,
    key: `ISS-${seq}`,
    complexity: null,
    landed: false,
    landedAt: null,
    ended: null,
    startedAt: null,
    rank: seq,
    blockedBy: [],
    wait: null,
    ...over,
  };
}

const person: Wait = {
  who: 'A project writer',
  act: 'answer a question',
  reason: 'parked at needs_info',
  ref: null,
};

const run = (items: WorkItem[], h: History = history(20), projectWait: Wait | null = null) =>
  runForecast({ now: NOW, items, history: h, projectWait, seed: 7 });

describe('forecast honesty', () => {
  it('gives no number below the history floor', () => {
    const one = item();
    const read = run([one], history(9)).forecasts.get(one.key);
    expect(read).toEqual({
      label: 'forecast',
      asOf: NOW.toISOString(),
      kind: 'not_enough_history',
      n: 9,
      floor: 10,
    });
  });

  it('names the wait instead of a date when a person owes the next move', () => {
    const parked = item({ wait: person });
    const read = run([parked]).forecasts.get(parked.key);
    expect(read?.kind).toBe('paused');
    expect(read).toMatchObject({ who: 'A project writer', act: 'answer a question' });
    expect(read).not.toHaveProperty('p50At');
  });

  it('pauses a dependent down the blocks chain of a paused blocker', () => {
    const blocker = item({ wait: person });
    const middle = item({ blockedBy: [blocker.key] });
    const last = item({ blockedBy: [middle.key] });
    const read = run([blocker, middle, last]).forecasts;
    expect(read.get(last.key)).toMatchObject({ kind: 'paused', who: 'A project writer' });
    expect(read.get(last.key)?.kind === 'paused' && read.get(last.key)).toMatchObject({
      reason: expect.stringContaining(`waits on ${middle.key}`),
    });
  });

  it('pauses every open issue on a project-wide outage, and leaves the landed ones landed', () => {
    const outage: Wait = {
      who: 'Whoever can reach box-1',
      act: 'wait for the usage limit to reset',
      reason: 'no runner can take work: box-1 is rate-limited',
      ref: 'box-1',
    };
    const open = item();
    const done = item({ landed: true, landedAt: new Date(NOW.getTime() - MINUTE) });
    const read = run([open, done], history(20), outage).forecasts;
    expect(read.get(open.key)).toMatchObject({ kind: 'paused', ref: 'box-1' });
    expect(read.get(done.key)?.kind).toBe('landed');
  });

  it('pauses a cycle of blocks edges rather than looping', () => {
    const a = item();
    const b = item({ blockedBy: [a.key] });
    a.blockedBy = [b.key];
    const read = run([a, b]).forecasts;
    expect(read.get(a.key)).toMatchObject({ kind: 'paused', act: 'break the cycle' });
    expect(read.get(b.key)?.kind).toBe('paused');
  });

  it('is never one date: a labelled range with its sample size', () => {
    const one = item();
    const read = run([one]).forecasts.get(one.key);
    if (read?.kind !== 'forecast') throw new Error(`expected a range, read ${read?.kind}`);
    expect(read.label).toBe('forecast');
    expect(read.p85Minutes).toBeGreaterThanOrEqual(read.p50Minutes);
    expect(Date.parse(read.p85At)).toBeGreaterThanOrEqual(Date.parse(read.p50At));
    expect(read.basis.n).toBe(20);
  });
});

describe('forecast arithmetic', () => {
  it('puts an issue behind three others at one lane near four cycles out', () => {
    const queue = [item(), item(), item(), item()];
    const h = history(20);
    const conc = concurrencyOf(h);
    expect(conc?.value).toBe(1);
    const target = queue[3];
    if (!target) throw new Error('no target');
    const read = run(queue, h).forecasts.get(target.key);
    if (read?.kind !== 'forecast') throw new Error(`expected a range, read ${read?.kind}`);
    const p50 = percentile(
      h.samples.map((s) => s.minutes).sort((x, y) => x - y),
      0.5,
    );
    expect(read.ahead).toBe(3);
    expect(read.p50Minutes).toBeLessThanOrEqual(4 * p50 * 1.1);
    expect(read.p85Minutes).toBeGreaterThanOrEqual(4 * p50 * 0.9);
  });

  it('reads two lanes off a history that landed twice as much', () => {
    const h: History = {
      samples: Array.from({ length: 48 }, () => ({ minutes: 60, complexity: null })),
      spanDays: 1,
      peak: null,
    };
    expect(concurrencyOf(h)?.value).toBe(2);
    const queue = [item(), item(), item(), item()];
    const last = queue[3];
    if (!last) throw new Error('no last');
    const read = run(queue, h).forecasts.get(last.key);
    expect(read).toMatchObject({ kind: 'forecast', p50Minutes: 120, p85Minutes: 120 });
  });

  it('never works more lanes than the project has had runs live at once lately', () => {
    // a burst: 36 landings in one day, each six hours from start to landing, reads L ≈ 9 by
    // Little's law; the box never had more than two runs live at once
    const burst: History = {
      samples: Array.from({ length: 36 }, () => ({ minutes: 360, complexity: null })),
      spanDays: 1,
      peak: 2,
    };
    const c = concurrencyOf(burst);
    expect(c?.value).toBe(2);
    expect(c?.basis).toMatch(/held to 2: the most runs live at once over the last 14 days/);
    expect(concurrencyOf({ ...burst, peak: null })).toMatchObject({
      value: 9,
      basis: expect.stringMatching(/not held to a run count: no run was live in the last 14 days$/),
    });
    expect(concurrencyOf({ ...burst, peak: 0 })?.value).toBe(1);
    const queue = [item(), item(), item(), item()];
    const last = queue[3];
    if (!last) throw new Error('no last');
    expect(run(queue, burst).forecasts.get(last.key)).toMatchObject({
      kind: 'forecast',
      p50Minutes: 720,
      basis: { concurrency: 2 },
    });
  });

  it('keeps the lanes the history reads where the peak is higher', () => {
    expect(concurrencyOf({ ...history(20), peak: 5 })?.value).toBe(1);
  });

  it('starts a dependent only once its blocker lands', () => {
    const blocker = item({ rank: 2 });
    const dependent = item({ rank: 1, blockedBy: [blocker.key] });
    const ran = run([dependent, blocker]);
    const b = ran.landings.get(blocker.key);
    const d = ran.landings.get(dependent.key);
    if (!b || !d) throw new Error('no landings');
    for (let t = 0; t < b.length; t++) expect(d[t]).toBeGreaterThan(b[t] as number);
    expect(ran.forecasts.get(dependent.key)).toMatchObject({ waitsOn: [blocker.key] });
  });

  it('finishes an item in flight sooner than a fresh one', () => {
    const flying = item({ startedAt: new Date(NOW.getTime() - 50 * MINUTE) });
    const read = run([flying]).forecasts.get(flying.key);
    if (read?.kind !== 'forecast') throw new Error(`expected a range, read ${read?.kind}`);
    expect(read.p85Minutes).toBeLessThanOrEqual(25);
  });

  it('samples a complexity of its own only once it clears the floor', () => {
    const samples: CycleSample[] = [
      ...Array.from({ length: 12 }, () => ({ minutes: 600, complexity: 'l' })),
      ...Array.from({ length: 12 }, () => ({ minutes: 30, complexity: 's' })),
      ...Array.from({ length: 3 }, () => ({ minutes: 5, complexity: 'xs' })),
    ];
    const big = item({ complexity: 'l' });
    const tiny = item({ complexity: 'xs' });
    const read = runForecast({
      now: NOW,
      items: [big, tiny],
      history: { samples, spanDays: 60, peak: null },
      projectWait: null,
      seed: 1,
    });
    expect(read.basisOf('l')?.complexity).toBe('l');
    expect(read.basisOf('xs')?.complexity).toBeNull();
  });

  it('reads the same range from the same facts', () => {
    const a = item();
    const b = item();
    expect(run([a, b]).forecasts.get(b.key)).toEqual(run([a, b]).forecasts.get(b.key));
  });
});

describe('scope forecast', () => {
  it('ranges the last landing, at least as late as any member', () => {
    const queue = [item(), item(), item()];
    const ran = run(queue);
    const scope = scopeForecast(
      ran,
      queue.map((i) => i.key),
      NOW,
    );
    if (scope?.kind !== 'forecast') throw new Error(`expected a range, read ${scope?.kind}`);
    for (const one of queue) {
      const own = ran.forecasts.get(one.key);
      if (own?.kind !== 'forecast') throw new Error('member not ranged');
      expect(scope.p85Minutes).toBeGreaterThanOrEqual(own.p85Minutes);
    }
  });

  it('is paused when any member waits on a person', () => {
    const parked = item({ wait: person });
    const free = item();
    const ran = run([parked, free]);
    expect(scopeForecast(ran, [free.key, parked.key], NOW)).toMatchObject({ kind: 'paused' });
  });
});

describe('late', () => {
  const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE);
  const p85 = (h: History) => run([item()], h).basisOf(null)?.cycleP85Minutes ?? Number.NaN;

  it('reads work run past the p85 of similar landed work as late, by how much', () => {
    const started = item({ startedAt: ago(180) });
    const read = run([started]).forecasts.get(started.key);
    const by = 180 - p85(history(20));
    expect(read).toMatchObject({
      kind: 'forecast',
      late: { reason: 'p85_passed', byMinutes: by },
    });
    expect(by).toBeGreaterThan(60);
  });

  it('does not call work late that is still inside its p85, or that has not started', () => {
    const fresh = item({ startedAt: ago(10) });
    const queued = item();
    const read = run([fresh, queued]).forecasts;
    expect(read.get(fresh.key)).toMatchObject({ kind: 'forecast', late: null });
    expect(read.get(queued.key)).toMatchObject({ kind: 'forecast', late: null });
  });

  it('is late exactly at the p85, not before it', () => {
    const edge = p85(history(20));
    const at = item({ startedAt: ago(edge - 1) });
    const past = item({ startedAt: ago(edge + 1) });
    const read = run([at, past]).forecasts;
    expect(read.get(at.key)).toMatchObject({ late: null });
    expect(read.get(past.key)).toMatchObject({ late: { byMinutes: 1 } });
  });

  it('reads a person owing the next move for over a day as late, and a fresh wait or an unknown start as not', () => {
    const stale = item({ wait: { ...person, since: ago(30 * 60).toISOString() } });
    const fresh = item({ wait: { ...person, since: ago(120).toISOString() } });
    const unknown = item({ wait: person });
    const read = run([stale, fresh, unknown]).forecasts;
    expect(read.get(stale.key)).toMatchObject({
      kind: 'paused',
      since: ago(30 * 60).toISOString(),
      late: { reason: 'waiting_over_day', byMinutes: 6 * 60 },
    });
    expect(read.get(fresh.key)).toMatchObject({ kind: 'paused', late: null });
    expect(read.get(unknown.key)).toMatchObject({ kind: 'paused', since: null, late: null });
  });

  it('refuses a wait that began at no time, by name', () => {
    const bad = item({ wait: { ...person, since: 'yesterday-ish' } });
    expect(() => run([bad])).toThrow(/a wait began at "yesterday-ish", which is not a time/);
  });

  it('makes a scope as late as its latest member', () => {
    const a = item({ startedAt: ago(200) });
    const b = item({ startedAt: ago(100) });
    const c = item();
    const ran = run([a, b, c]);
    const late = (k: string) =>
      (ran.forecasts.get(k) as { late: { byMinutes: number } | null }).late;
    expect(scopeForecast(ran, [a.key, b.key, c.key], NOW)).toMatchObject({
      kind: 'forecast',
      late: { byMinutes: late(a.key)?.byMinutes },
    });
  });
});
