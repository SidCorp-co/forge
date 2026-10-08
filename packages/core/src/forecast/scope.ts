/**
 * A requirement's issues, or the draft release's, forecast as one: when the last of them lands,
 * and when the last of them is in people's hands (`delivery.ts`).
 */

import type {
  ComingNextForecast,
  Forecast,
  RequirementForecasts,
  ScopeForecast,
} from '@forge/contracts/forecast';
import { say } from '@forge/contracts/said';
import { draftReleaseIssueIds } from '../release-batch/index.js';
import { deliveryOf, type ReleaseFacts, releaseLegOf, type Shipped } from './delivery.js';
import {
  type IssueRow,
  issueRowsByIds,
  issueRowsOfRequirements,
  liveRequirements,
  type RequirementRow,
  readAnchor,
  requirementBySeq,
} from './facts.js';
import { scopeForecast, scopeLandings, seedOf, waitOn } from './model.js';
import { withMoves } from './moves.js';
import { issueProgressOf } from './progress.js';
import { type Facts, forecastOf, pausedOf, simulate, stamp } from './read.js';
import { type ForecastViewer, readReleaseFacts, readShipped } from './release.js';

/** One simulation, the release that follows it, and who shipped the closed issues in view. */
export interface Reads {
  f: Facts;
  release: ReleaseFacts;
  shipped: Map<string, Shipped>;
}

export async function readsFor(
  projectId: string,
  now: Date,
  rows: readonly IssueRow[],
  viewer: ForecastViewer | null,
): Promise<Reads> {
  const closed = rows.filter((r) => r.status === 'closed').map((r) => r.id);
  const anchor = await readAnchor(projectId, now);
  const [f, release, shipped] = await Promise.all([
    simulate(projectId, now, viewer, anchor),
    readReleaseFacts(projectId, anchor.at, viewer),
    readShipped(projectId, closed),
  ]);
  return { f, release, shipped };
}

function latestShipped(members: readonly IssueRow[], shipped: Map<string, Shipped>): Shipped {
  const known = members.flatMap((m) => {
    const s = shipped.get(m.id);
    return s?.at ? [s] : [];
  });
  known.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  return known[known.length - 1] ?? { version: null, at: null };
}

function latestLanding(asOf: string, times: readonly (string | null)[]): Forecast {
  const known = times.filter((t): t is string => t !== null).map((t) => new Date(t).toISOString());
  known.sort();
  return { ...stamp(asOf), kind: 'landed', landedAt: known[known.length - 1] ?? null };
}

export function scopeOf(
  r: Reads,
  rows: readonly IssueRow[],
  scope: ScopeForecast['scope'],
  key: string,
  title: string | null,
): ScopeForecast {
  const { f } = r;
  const members = rows.filter((m) => m.status !== 'dropped');
  const read = members.map((m) => ({ row: m, forecast: forecastOf(f, m) }));
  const landed = read.flatMap((m) => (m.forecast.kind === 'landed' ? [m.forecast.landedAt] : []));
  const open = read.filter((m) => m.forecast.kind !== 'landed' && m.forecast.kind !== 'ended');
  const openKeys = open.flatMap((m) => {
    const k = f.keyOf.get(m.row.id);
    return k ? [k] : [];
  });
  const forecast =
    members.length === 0
      ? null
      : open.length === 0
        ? latestLanding(f.run.asOf, landed)
        : scopeForecast(f.run, openKeys, f.now);
  const unshipped = members.filter((m) => m.status !== 'closed');
  const lastLanding = latestLanding(
    f.run.asOf,
    unshipped.map((m) => m.merged_at),
  );
  const delivery = forecast
    ? deliveryOf({
        asOf: f.run.asOf,
        now: f.now,
        landing: forecast,
        trials: forecast.kind === 'forecast' ? scopeLandings(f.run, openKeys) : null,
        landedAt:
          lastLanding.kind === 'landed' && lastLanding.landedAt
            ? new Date(lastLanding.landedAt)
            : null,
        shipped: unshipped.length === 0 ? latestShipped(members, r.shipped) : null,
        release: r.release,
        seed: seedOf(`${key}:release`),
      })
    : null;
  return {
    ...stamp(f.run.asOf),
    scope,
    key,
    title,
    progress: issueProgressOf(members),
    forecast,
    next: null,
    delivery,
    anchor: { at: f.anchor.at.toISOString(), event: f.anchor.event },
    moved: null,
  };
}

const requirementScope = (r: Reads, req: RequirementRow, rows: readonly IssueRow[]) =>
  scopeOf(r, rows, 'requirement', `REQ-${req.req_seq}`, req.title);

export async function readRequirementForecast(
  projectId: string,
  reqSeq: number,
  viewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<ScopeForecast | null> {
  const req = await requirementBySeq(projectId, reqSeq);
  if (!req) return null;
  const rows = (await issueRowsOfRequirements(projectId, [req.id])).get(req.id) ?? [];
  const [scope] = await withMoves(projectId, [
    requirementScope(await readsFor(projectId, now, rows, viewer), req, rows),
  ]);
  return scope ?? null;
}

async function allRequirementScopes(
  projectId: string,
  now: Date,
  viewer: ForecastViewer | null,
  extra: readonly IssueRow[] = [],
): Promise<{ reads: Reads; scopes: ScopeForecast[] }> {
  const reqs = await liveRequirements(projectId);
  const byReq = await issueRowsOfRequirements(
    projectId,
    reqs.map((q) => q.id),
  );
  const reads = await readsFor(projectId, now, [...[...byReq.values()].flat(), ...extra], viewer);
  return {
    reads,
    scopes: reqs.map((q) => requirementScope(reads, q, byReq.get(q.id) ?? [])),
  };
}

/** Every live requirement's end-to-end forecast from one simulation, for the list rows. */
export async function readRequirementForecasts(
  projectId: string,
  viewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<RequirementForecasts> {
  const { reads, scopes } = await allRequirementScopes(projectId, now, viewer);
  return {
    ...stamp(reads.f.run.asOf),
    projectId,
    requirements: await withMoves(projectId, scopes),
  };
}

/**
 * The draft: the landed issues waiting at the release gate that no version holds yet. What follows
 * is the release, which `next` names as a person's act wherever a person makes it.
 */
function draftScope(r: Reads, rows: readonly IssueRow[]): ScopeForecast {
  const read = scopeOf(r, rows, 'release', 'draft', null);
  const leg = releaseLegOf(r.release);
  if (read.forecast?.kind !== 'landed' || leg.kind !== 'person') return read;
  return {
    ...read,
    next: pausedOf(
      r.f.run.asOf,
      waitOn(
        {
          ...leg.says,
          reason: say('forecast.reason.allLanded', { reason: leg.says.reason }),
        },
        null,
        read.forecast.landedAt,
      ),
    ),
  };
}

export async function readDraftReleaseForecast(
  projectId: string,
  viewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<ScopeForecast> {
  const rows = await issueRowsByIds(projectId, await draftReleaseIssueIds(projectId));
  const [draft] = await withMoves(projectId, [
    draftScope(await readsFor(projectId, now, rows, viewer), rows),
  ]);
  if (!draft) throw new Error('forecast: the draft scope left its own move read');
  return draft;
}

const SOONEST: Record<Forecast['kind'], number> = {
  forecast: 0,
  paused: 1,
  not_enough_history: 2,
  landed: 3,
  ended: 4,
};

/**
 * Every live requirement's scope, and what comes next: each requirement with work still to land,
 * soonest landing first, then the draft release, all from one simulation.
 */
export async function readForecastLine(
  projectId: string,
  viewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<{ requirements: ScopeForecast[]; coming: ComingNextForecast }> {
  const draftRows = await issueRowsByIds(projectId, await draftReleaseIssueIds(projectId));
  const all = await allRequirementScopes(projectId, now, viewer, draftRows);
  const reads = all.reads;
  const [draftRead, ...scopes] = await withMoves(projectId, [
    draftScope(reads, draftRows),
    ...all.scopes,
  ]);
  if (!draftRead) throw new Error('forecast: the draft scope left its own move read');
  const open = scopes.filter(
    (s) => s.forecast && s.forecast.kind !== 'landed' && s.forecast.kind !== 'ended',
  );
  const p50 = (s: ScopeForecast) =>
    s.forecast?.kind === 'forecast' ? s.forecast.p50Minutes : Number.POSITIVE_INFINITY;
  open.sort(
    (a, b) =>
      SOONEST[a.forecast?.kind ?? 'ended'] - SOONEST[b.forecast?.kind ?? 'ended'] ||
      p50(a) - p50(b) ||
      a.key.localeCompare(b.key, undefined, { numeric: true }),
  );
  return {
    requirements: scopes,
    coming: {
      ...stamp(reads.f.run.asOf),
      projectId,
      requirements: open,
      draft: draftRead,
    },
  };
}

/** Each requirement with work still to land, soonest landing first, then the draft release. */
export async function readComingNext(
  projectId: string,
  viewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<ComingNextForecast> {
  return (await readForecastLine(projectId, viewer, now)).coming;
}
