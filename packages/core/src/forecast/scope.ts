/**
 * A requirement's issues, or the draft release's, forecast as one: when the last of them lands.
 */

import type { Forecast, ScopeForecast } from '@forge/contracts/forecast';
import { approvalRequired } from '../project-config/index.js';
import { draftReleaseIssueIds } from '../release-batch/index.js';
import { type IssueRow, issueRowsByIds, requirementIssueRows } from './facts.js';
import { scopeForecast } from './model.js';
import { type Facts, forecastOf, pausedOf, simulate, stamp } from './read.js';

function scopeOf(
  f: Facts,
  rows: readonly IssueRow[],
  scope: ScopeForecast['scope'],
  key: string,
): ScopeForecast {
  const members = rows.filter((r) => r.status !== 'dropped');
  const read = members.map((r) => ({ row: r, forecast: forecastOf(f, r) }));
  const landed = read.flatMap((m) => (m.forecast.kind === 'landed' ? [m.forecast.landedAt] : []));
  const open = read.filter((m) => m.forecast.kind !== 'landed' && m.forecast.kind !== 'ended');
  const forecast =
    members.length === 0
      ? null
      : open.length === 0
        ? latestLanding(f.run.asOf, landed)
        : scopeForecast(
            f.run,
            open.flatMap((m) => {
              const k = f.keyOf.get(m.row.id);
              return k ? [k] : [];
            }),
            f.now,
          );
  return {
    ...stamp(f.run.asOf),
    scope,
    key,
    total: members.length,
    landed: landed.length,
    forecast,
    next: null,
  };
}

function latestLanding(asOf: string, times: readonly (string | null)[]): Forecast {
  const known = times.filter((t): t is string => t !== null).map((t) => new Date(t).toISOString());
  known.sort();
  return { ...stamp(asOf), kind: 'landed', landedAt: known[known.length - 1] ?? null };
}

export async function readRequirementForecast(
  projectId: string,
  reqSeq: number,
  now: Date = new Date(),
): Promise<ScopeForecast | null> {
  const [rows, f] = await Promise.all([
    requirementIssueRows(projectId, reqSeq),
    simulate(projectId, now),
  ]);
  if (!rows) return null;
  return scopeOf(f, rows, 'requirement', `REQ-${reqSeq}`);
}

/**
 * The draft release: the issues waiting at the release gate that no version holds yet. They have
 * landed by the time they reach it, so what follows is the cut, which `next` names as a person's
 * wait wherever the project requires an approval.
 */
export async function readDraftReleaseForecast(
  projectId: string,
  now: Date = new Date(),
): Promise<ScopeForecast> {
  const ids = await draftReleaseIssueIds(projectId);
  const [rows, f, required] = await Promise.all([
    issueRowsByIds(projectId, ids),
    simulate(projectId, now),
    approvalRequired(projectId),
  ]);
  const read = scopeOf(f, rows, 'release', 'draft');
  if (read.forecast?.kind !== 'landed' || !required) return read;
  return {
    ...read,
    next: pausedOf(f.run.asOf, {
      who: 'A release approver',
      act: 'cut the version, then approve the release',
      reason:
        'every included issue has landed; this project requires a person to approve each release on Releases',
      ref: null,
    }),
  };
}
