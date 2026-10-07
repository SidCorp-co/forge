/**
 * The forecast itself, pure: a seeded Monte Carlo over the project's own in_progress→landed
 * durations (Magennis's cycle-time sampling, Vacanti's "when will it be done"), run through the
 * queue in the order the dispatcher takes it, with each `blocks` edge holding its dependent until
 * the blocker lands, on as many lanes as Little's law reads off the history and never more than the
 * runs the project has had live at once lately. `read.ts` gathers the facts; every honesty rule below is a unit test in `model.test.ts`.
 */

import {
  type ForecastWaitSays,
  FORECAST_HISTORY_FLOOR,
  FORECAST_LABEL,
  FORECAST_PEAK_DAYS,
  FORECAST_TRIALS,
  FORECAST_WINDOW_DAYS,
  type Forecast,
  type ForecastBasis,
  type ForecastLate,
  type ForecastPaused,
  type ForecastRange,
} from '@forge/contracts/forecast';
import type { ProjectPermission } from '@forge/contracts/permissions';
import { type Said, say, sayEn } from '@forge/contracts/said';
import { holdersWho, nobodyHoldsAct } from '@forge/contracts/standing';
import { lateAfterP85, latestLate, lateWaiting } from './late.js';

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

export interface CycleSample {
  minutes: number;
  complexity: string | null;
}

export interface History {
  samples: readonly CycleSample[];
  /** Days the landings were counted over. */
  spanDays: number;
  /** The most declared runs live at once over the recent days; null where none was live. */
  peak: number | null;
}

export interface Wait {
  who: string;
  act: string;
  reason: string;
  ref: string | null;
  /** When the wait began, where it is known; absent, it is never called late. */
  since?: string | null;
  says: ForecastWaitSays;
}

/** A wait from what it says: its English rendered from `says`, never written beside it. */
export function waitOn(
  says: ForecastWaitSays,
  ref: string | null,
  since?: string | null,
): Wait {
  return {
    who: sayEn(says.who),
    act: sayEn(says.act),
    reason: sayEn(says.reason),
    ref,
    ...(since === undefined ? {} : { since }),
    says,
  };
}

/** A wait on the holders of `permission`, by name; nobody holding it says so and where it is granted. */
export function holdersWait(
  names: readonly string[],
  permission: ProjectPermission,
  act: Said,
  reason: Said,
  ref: string | null,
): Wait {
  return waitOn(
    {
      who: holdersWho(names),
      act: names.length === 0 ? nobodyHoldsAct(act, permission) : act,
      reason,
    },
    ref,
  );
}

export interface WorkItem {
  id: string;
  key: string;
  complexity: string | null;
  /** Set once it has landed; null on an issue past the landing with no merge time. */
  landedAt: Date | null;
  landed: boolean;
  ended: string | null;
  /** When work on it started, where it is in flight now; null where it waits in the queue. */
  startedAt: Date | null;
  /** The dispatcher's order among queued items, lowest first; in-flight items go before all. */
  rank: number;
  /** Keys of the unsettled `blocks` blockers that have not landed. */
  blockedBy: readonly string[];
  /** A wait of its own: a person, a gate. */
  wait: Wait | null;
}

interface Concurrency {
  value: number;
  basis: string;
}

interface ForecastInput {
  now: Date;
  items: readonly WorkItem[];
  history: History;
  /** A wait that holds the whole project, such as no runner able to take work. */
  projectWait: Wait | null;
  /** Who holds project.write, by name: whom a wait only a writer settles names. */
  writers: readonly string[];
  seed: number;
  trials?: number;
  floor?: number;
}

export interface ForecastRun {
  asOf: string;
  forecasts: Map<string, Forecast>;
  /** The trials' landing minutes from now, per simulated item, for a scope to take maxima over. */
  landings: Map<string, Float64Array>;
  basisOf: (complexity: string | null) => ForecastBasis | null;
  concurrency: Concurrency | null;
  trials: number;
}

/** mulberry32: a seeded generator, so one set of facts always reads the same range. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] as number;
}

const ascending = (values: readonly number[]) => [...values].sort((a, b) => a - b);

/**
 * Little's law, L = λ·W: the issues the project has had in progress at once on average, read from
 * its landings per day and their mean duration, never above the most runs it has actually had live
 * at once lately. A burst of landings reads a λ no lane ever sustained, and the work a master runs
 * as a two-run wave is never worked six at a time (HOP ISS-71's next-day p85), however many issues
 * stand at `in_progress` meanwhile.
 */
export function concurrencyOf(history: History): Concurrency | null {
  const n = history.samples.length;
  if (n === 0 || history.spanDays <= 0) return null;
  const perDay = n / history.spanDays;
  const meanMinutes = history.samples.reduce((s, c) => s + c.minutes, 0) / n;
  const wip = (perDay * meanMinutes) / DAY_MINUTES;
  const little = Math.max(1, Math.round(wip));
  const read = `Little's law over the last ${FORECAST_WINDOW_DAYS} days: ${perDay.toFixed(1)} landings a day × ${Math.round(meanMinutes)} min mean in progress ≈ ${wip.toFixed(1)} at once`;
  if (history.peak === null) {
    return {
      value: little,
      basis: `${read}, not held to a run count: no run was live in the last ${FORECAST_PEAK_DAYS} days`,
    };
  }
  const cap = Math.max(1, history.peak);
  if (little <= cap) return { value: little, basis: read };
  return {
    value: cap,
    basis: `${read}, held to ${cap}: the most runs live at once over the last ${FORECAST_PEAK_DAYS} days`,
  };
}

/** The most spells open at one instant; a spell ending as another starts does not overlap it. */
export function peakOf(spells: readonly (readonly [number, number])[]): number {
  const edges = spells
    .filter(([a, b]) => b > a)
    .flatMap(([a, b]) => [
      [a, 1],
      [b, -1],
    ])
    .sort((x, y) => (x[0] as number) - (y[0] as number) || (x[1] as number) - (y[1] as number));
  let open = 0;
  let most = 0;
  for (const [, step] of edges) {
    open += step as number;
    most = Math.max(most, open);
  }
  return most;
}

function pools(samples: readonly CycleSample[], floor: number) {
  const all = samples.map((s) => s.minutes);
  const byComplexity = new Map<string, number[]>();
  for (const s of samples) {
    if (!s.complexity) continue;
    const held = byComplexity.get(s.complexity) ?? [];
    held.push(s.minutes);
    byComplexity.set(s.complexity, held);
  }
  return (complexity: string | null): { minutes: number[]; complexity: string | null } => {
    const own = complexity ? byComplexity.get(complexity) : undefined;
    return own && own.length >= floor
      ? { minutes: own, complexity }
      : { minutes: all, complexity: null };
  };
}

const stamp = (asOf: string) => ({ label: FORECAST_LABEL, asOf });

export function pausedOf(asOf: string, wait: Wait): ForecastPaused {
  const since = wait.since ?? null;
  return {
    ...stamp(asOf),
    kind: 'paused',
    who: wait.who,
    act: wait.act,
    reason: wait.reason,
    ref: wait.ref,
    since,
    says: wait.says,
    late: lateWaiting(since, new Date(asOf)),
  };
}

/** An item's own wait, else the first blocker's that is paused, followed down the chain. */
function waitsOf(
  items: readonly WorkItem[],
  projectWait: Wait | null,
  writers: readonly string[],
): Map<string, Wait> {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const out = new Map<string, Wait>();
  const clear = new Set<string>();
  const visiting = new Set<string>();
  const resolve = (item: WorkItem): Wait | null => {
    if (item.landed || item.ended || clear.has(item.key)) return null;
    const known = out.get(item.key);
    if (known) return known;
    if (visiting.has(item.key)) {
      return holdersWait(
        writers,
        'project.write',
        say('forecast.act.breakCycle'),
        say('forecast.reason.cycle', { key: item.key }),
        item.key,
      );
    }
    visiting.add(item.key);
    let wait = item.wait ?? projectWait;
    for (const key of wait ? [] : item.blockedBy) {
      const blocker = byKey.get(key);
      const held = blocker
        ? resolve(blocker)
        : waitOn(
            {
              who: say('standing.who.named', { name: key }),
              act: say('forecast.act.landFirst'),
              reason: say('forecast.reason.notForecast', { item: item.key, key }),
            },
            key,
          );
      if (held) {
        wait = blocker
          ? waitOn(
              {
                ...held.says,
                reason: say('forecast.reason.waitsOn', { key, reason: held.says.reason }),
              },
              held.ref ?? key,
              held.since,
            )
          : held;
        break;
      }
    }
    visiting.delete(item.key);
    if (wait) out.set(item.key, wait);
    else clear.add(item.key);
    return wait;
  };
  for (const item of items) resolve(item);
  return out;
}

interface Lane {
  freeAt: number;
}

/** One trial: every simulated item's landing, in minutes from now. */
function trial(
  order: readonly WorkItem[],
  draw: (item: WorkItem, ageMinutes: number) => number,
  lanes: number,
  now: Date,
  out: Map<string, number>,
): void {
  const free: Lane[] = Array.from({ length: lanes }, () => ({ freeAt: 0 }));
  const earliest = () => free.reduce((a, b) => (b.freeAt < a.freeAt ? b : a));
  const queue = [...order];
  while (queue.length > 0) {
    const lane = earliest();
    const readyAt = (item: WorkItem) =>
      item.blockedBy.reduce((t, key) => Math.max(t, out.get(key) ?? Number.POSITIVE_INFINITY), 0);
    let at = queue.findIndex((item) => readyAt(item) <= lane.freeAt);
    if (at < 0) {
      const next = Math.min(...queue.map(readyAt));
      if (!Number.isFinite(next)) {
        throw new Error(
          `forecast: ${queue.map((i) => i.key).join(', ')} wait on blockers no lane ever lands; waitsOf should have paused them`,
        );
      }
      lane.freeAt = next;
      at = queue.findIndex((item) => readyAt(item) <= lane.freeAt);
    }
    const [item] = queue.splice(at, 1);
    if (!item) throw new Error('forecast: the ready item left the queue before it was taken');
    const age = item.startedAt
      ? Math.max(0, (now.getTime() - item.startedAt.getTime()) / MINUTE)
      : 0;
    const landsAt = lane.freeAt + draw(item, age);
    lane.freeAt = landsAt;
    out.set(item.key, landsAt);
  }
}

/** In flight first, longest running first; then the queue in the dispatcher's order. */
function dispatchOrder(items: readonly WorkItem[]): WorkItem[] {
  const flying = items
    .filter((i) => i.startedAt)
    .sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
  const queued = items.filter((i) => !i.startedAt).sort((a, b) => a.rank - b.rank);
  return [...flying, ...queued];
}

export function runForecast(input: ForecastInput): ForecastRun {
  const floor = input.floor ?? FORECAST_HISTORY_FLOOR;
  const trials = input.trials ?? FORECAST_TRIALS;
  const asOf = input.now.toISOString();
  const forecasts = new Map<string, Forecast>();
  const landings = new Map<string, Float64Array>();
  const n = input.history.samples.length;
  const concurrency = concurrencyOf(input.history);
  const pick = pools(input.history.samples, floor);
  const throughputPerDay = input.history.spanDays > 0 ? n / input.history.spanDays : 0;
  const basisOf = (complexity: string | null): ForecastBasis | null => {
    if (n < floor || !concurrency) return null;
    const pool = pick(complexity);
    const sorted = ascending(pool.minutes);
    return {
      n: pool.minutes.length,
      floor,
      windowDays: FORECAST_WINDOW_DAYS,
      complexity: pool.complexity,
      cycleP50Minutes: Math.round(percentile(sorted, 0.5)),
      cycleP85Minutes: Math.round(percentile(sorted, 0.85)),
      throughputPerDay: Math.round(throughputPerDay * 10) / 10,
      concurrency: concurrency.value,
      concurrencyBasis: concurrency.basis,
    };
  };

  const waits = waitsOf(input.items, input.projectWait, input.writers);
  const live: WorkItem[] = [];
  for (const item of input.items) {
    if (item.landed) {
      forecasts.set(item.key, {
        ...stamp(asOf),
        kind: 'landed',
        landedAt: item.landedAt?.toISOString() ?? null,
      });
      continue;
    }
    if (item.ended) {
      forecasts.set(item.key, { ...stamp(asOf), kind: 'ended', status: item.ended });
      continue;
    }
    const wait = waits.get(item.key);
    if (wait) {
      forecasts.set(item.key, pausedOf(asOf, wait));
      continue;
    }
    if (n < floor || !concurrency) {
      forecasts.set(item.key, { ...stamp(asOf), kind: 'not_enough_history', n, floor });
      continue;
    }
    live.push(item);
  }
  if (live.length === 0 || !concurrency) {
    return { asOf, forecasts, landings, basisOf, concurrency, trials };
  }

  const order = dispatchOrder(live);
  const random = seeded(input.seed);
  const sampleOf = (minutes: readonly number[]) =>
    minutes[Math.floor(random() * minutes.length)] as number;
  // an item in flight finishes like the landed ones that ran at least as long; one older than any
  // of them has no such history, so it is drawn as a fresh cycle rather than as landing now
  const draw = (item: WorkItem, age: number): number => {
    const { minutes } = pick(item.complexity);
    if (age <= 0) return sampleOf(minutes);
    const longer = minutes.filter((m) => m > age);
    return longer.length > 0 ? sampleOf(longer) - age : sampleOf(minutes);
  };
  for (const item of order) landings.set(item.key, new Float64Array(trials));
  const one = new Map<string, number>();
  for (let t = 0; t < trials; t++) {
    one.clear();
    trial(order, draw, concurrency.value, input.now, one);
    for (const item of order) {
      const at = landings.get(item.key);
      if (at) at[t] = one.get(item.key) ?? Number.POSITIVE_INFINITY;
    }
  }

  order.forEach((item, position) => {
    const at = landings.get(item.key);
    const basis = basisOf(item.complexity);
    if (!at || !basis) return;
    forecasts.set(
      item.key,
      rangeOf(asOf, input.now, at, basis, {
        ahead: order.slice(0, position).map((i) => i.key),
        waitsOn: [...item.blockedBy],
        late: lateAfterP85(item.startedAt, basis.cycleP85Minutes, input.now),
      }),
    );
  });
  return { asOf, forecasts, landings, basisOf, concurrency, trials };
}

const AHEAD_KEYS_SHOWN = 5;

export function rangeOf(
  asOf: string,
  now: Date,
  landings: Float64Array,
  basis: ForecastBasis,
  path: { ahead: readonly string[]; waitsOn: readonly string[]; late: ForecastLate | null },
): ForecastRange {
  const sorted = Float64Array.from(landings).sort();
  const p50 = Math.round(percentile(sorted, 0.5));
  const p85 = Math.round(percentile(sorted, 0.85));
  return {
    ...stamp(asOf),
    kind: 'forecast',
    p50Minutes: p50,
    p85Minutes: p85,
    p50At: new Date(now.getTime() + p50 * MINUTE).toISOString(),
    p85At: new Date(now.getTime() + p85 * MINUTE).toISOString(),
    ahead: path.ahead.length,
    aheadKeys: path.ahead.slice(0, AHEAD_KEYS_SHOWN),
    waitsOn: [...path.waitsOn],
    basis,
    late: path.late,
  };
}

/**
 * When the last of a scope's open issues lands: the per-trial maximum over them, so the range is
 * of the last landing, not of each. A paused or history-short member decides the scope, since no
 * honest maximum can be taken over a member with no date.
 */
export function scopeForecast(
  run: ForecastRun,
  openKeys: readonly string[],
  now: Date,
): Forecast | null {
  const members = openKeys.map((key) => run.forecasts.get(key)).filter((f): f is Forecast => !!f);
  const decides =
    members.find((f) => f.kind === 'paused') ??
    members.find((f) => f.kind === 'not_enough_history');
  if (decides) return decides;
  const ranged = members.filter((f): f is ForecastRange => f.kind === 'forecast');
  const last = [...ranged].sort((a, b) => b.p85Minutes - a.p85Minutes)[0];
  if (!last) return null;
  return rangeOf(run.asOf, now, scopeLandings(run, openKeys), last.basis, {
    ahead: last.aheadKeys,
    waitsOn: last.waitsOn,
    late: latestLate(ranged.map((f) => f.late)),
  });
}

/** Each trial's last landing among `keys`, in minutes from now; zero where none of them was simulated. */
export function scopeLandings(run: ForecastRun, keys: readonly string[]): Float64Array {
  const latest = new Float64Array(run.trials);
  for (const key of keys) {
    const at = run.landings.get(key);
    if (!at) continue;
    for (let t = 0; t < run.trials; t++) latest[t] = Math.max(latest[t] as number, at[t] as number);
  }
  return latest;
}
