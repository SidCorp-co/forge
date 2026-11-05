// One project's timeline lane (ISS-979, the owner's mockup v3), built from what core already read for
// the row: its runs as bars, its issues' status moves gathered into batches, the releases cut, shipped
// or ended over the lane, and the decisions waiting on the reader as pins where each wait began. The
// page draws these as given and infers none of them (the issue's rule: batches, releases and waits
// come from core's read model, never from the browser).

import {
  ORG_ACTIVITY_BATCH_MINUTES,
  type OrgActivityBatch,
  type OrgActivityBatchMove,
  type OrgActivityLane,
  type OrgActivityLaneRelease,
  type OrgActivityPerson,
  type OrgActivitySpan,
  type OrgActivityWait,
} from '@forge/contracts/org-activity';
import type { ProjectEvent } from './events.js';

const BATCH_MS = ORG_ACTIVITY_BATCH_MINUTES * 60_000;

/**
 * Each run as a bar, from its start (or the lane's edge where it began before) to its end (or null
 * while it still runs), paired by its session; a run that ended before the lane is not drawn.
 */
export function runsOf(events: readonly ProjectEvent[], from: Date): OrgActivitySpan[] {
  const edge = from.toISOString();
  const open = new Map<string, OrgActivitySpan>();
  for (const e of [...events].reverse()) {
    if (!e.span) continue;
    if (e.kind === 'run_started') open.set(e.span, { from: e.at < edge ? edge : e.at, to: null });
    if (e.kind === 'run_ended') {
      const held = open.get(e.span) ?? { from: edge, to: null };
      open.set(e.span, { ...held, to: e.at });
    }
  }
  return [...open.values()].filter((s) => s.to === null || Date.parse(s.to) >= from.getTime());
}

/**
 * Items in time order, each gathered with the ones that follow it within the batch window of the
 * first: the one rule batches and waits share, so a marker never spans more than the window.
 */
function gathered<T>(items: readonly T[], at: (item: T) => number): { at: number; items: T[] }[] {
  const out: { at: number; items: T[] }[] = [];
  for (const item of [...items].sort((a, b) => at(a) - at(b))) {
    const last = out.at(-1);
    if (last && at(item) - last.at <= BATCH_MS) last.items.push(item);
    else out.push({ at: at(item), items: [item] });
  }
  return out;
}

/**
 * The lane's status moves as batches: moves within the window of a batch's first move are that batch,
 * and an issue that moved more than once in one batch is one entry, from its first status to its last.
 */
export function batchesOf(
  events: readonly ProjectEvent[],
  from: Date,
  to: Date,
): OrgActivityBatch[] {
  const moves = events.filter((e) => {
    const at = Date.parse(e.at);
    return e.kind === 'status' && at >= from.getTime() && at <= to.getTime();
  });
  return gathered(moves, (e) => Date.parse(e.at)).map((batch) => {
    const byIssue = new Map<string, OrgActivityBatchMove>();
    for (const e of batch.items) {
      if (!e.issueKey || !e.to) {
        throw new Error(
          `activity: a status move at ${e.at} names no ${!e.issueKey ? 'issue' : 'status'}: every move is read from an issue's own transition (events.ts:readProjectEvents)`,
        );
      }
      const held = byIssue.get(e.issueKey);
      byIssue.set(
        e.issueKey,
        held
          ? { ...held, to: e.to }
          : { issueKey: e.issueKey, title: e.issueTitle, from: e.from ?? null, to: e.to },
      );
    }
    return { at: new Date(batch.at).toISOString(), moves: [...byIssue.values()] };
  });
}

/**
 * The decisions waiting on the reader as pins: each placed where its wait began, at the lane's start
 * where it began before the lane or where core holds no start, and gathered as batches are. Those of
 * `total` the read carries no item for have no start core holds, so they are counted on the pin at the
 * lane's start (`more`): the pins add up to the reader's count, never fewer.
 */
export function waitsOf(
  items: readonly OrgActivityPerson[],
  from: Date,
  total: number = items.length,
): OrgActivityWait[] {
  const placed = (p: OrgActivityPerson) =>
    p.since === null ? from.getTime() : Math.max(from.getTime(), Date.parse(p.since));
  const waits = gathered(items, placed).map(
    (w): OrgActivityWait => ({ at: new Date(w.at).toISOString(), items: w.items, more: 0 }),
  );
  const more = Math.max(0, total - items.length);
  if (more === 0) return waits;
  const start = from.toISOString();
  const first = waits[0];
  if (first?.at === start) first.more = more;
  else waits.unshift({ at: start, items: [], more });
  return waits;
}

/** When core last recorded anything on the project: its newest event, or its master's last pass. */
export function lastActivityOf(
  events: readonly ProjectEvent[],
  lastPassEndedAt: string | null,
): string | null {
  const times = [...events.map((e) => e.at), ...(lastPassEndedAt ? [lastPassEndedAt] : [])];
  return times.length === 0
    ? null
    : new Date(Math.max(...times.map((t) => Date.parse(t)))).toISOString();
}

export function laneOf(
  events: readonly ProjectEvent[],
  from: Date,
  to: Date,
  releases: readonly OrgActivityLaneRelease[],
  waiting: { total: number; items: readonly OrgActivityPerson[] },
): OrgActivityLane {
  return {
    from: from.toISOString(),
    runs: runsOf(events, from),
    batches: batchesOf(events, from, to),
    releases: [...releases],
    waits: waitsOf(waiting.items, from, waiting.total),
  };
}
