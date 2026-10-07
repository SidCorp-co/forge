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
  return { samples, spanDays: span };
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
    };
    expect(concurrencyOf(h)?.value).toBe(2);
    const queue = [item(), item(), item(), item()];
    const last = queue[3];
    if (!last) throw new Error('no last');
    const read = run(queue, h).forecasts.get(last.key);
    expect(read).toMatchObject({ kind: 'forecast', p50Minutes: 120, p85Minutes: 120 });
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
      history: { samples, spanDays: 60 },
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
