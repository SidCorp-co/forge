// The gate issues outside a release's roster that the head its run reports already carries (ISS-962).
//
// The run reports the head it cut (`shipped-range.ts:recordRange`) and the release's tag is owed
// there. A head past the roster's own landings carries every gate issue landed below it too, so the
// release would ship them under its version while its record names only its roster: agenfold's
// 0.123.0 (roster ISS-127, ISS-128, ISS-142) was tagged at a939c3f, ISS-144's landing, while ISS-144
// waited for the 0.124.0 draft, and nothing said so.
//
// Read before the tag is owed: each gate issue outside the roster whose landing commit the head holds
// and the range's base does not (a landing the base holds shipped with an earlier release, ISS-774).
// The answer is the project's ancestry reader (`ancestry-source.ts`: the source host, or the box
// holding its checkout), which a write may ask; a landing that is the head itself needs no reader.
// Where no reader answers, or the issue's merge names no commit, the issue is `unchecked` with why,
// kept on the range and named wherever it is read, never guessed either way.
//
// A carried issue refuses the report (`RELEASE_RANGE_OUTSIDE_ROSTER`) rather than being taken into the
// release: the roster is what the release's notes, its criteria weighing and its approval were read
// over, and an issue held out of it (ISS-144 was held for the next draft) has passed none of them.

import type { ReleaseRangeUnchecked } from '@forge/contracts/release-page';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { issueDisplayIds } from '../issues/index.js';
import { agrees } from '../lib/plural.js';
import { type AncestryPair, pairKey } from '../runners/index.js';
import { type AncestryReader, ancestrySourceFor } from './ancestry-source.js';
import { RELEASE_GATE_STATUS } from './gate.js';

/** A gate issue outside the roster, and the commit its merge names (null where it names none). */
export interface OutsideIssue {
  id: string;
  key: string;
  commit: string | null;
}

/** What the head carries of the gate outside its roster, and what could not be placed, with why. */
export interface OutsideRead {
  carried: OutsideIssue[];
  unchecked: ReleaseRangeUnchecked[];
}

type Ask = AncestryReader['ask'];

const short = (sha: string) => sha.slice(0, 7);

/**
 * Of `outside`, those `head` carries and `base` does not, read through `ask`; `base` null where no
 * release shipped before, so every landing the head holds is in its range. A landing that is the head
 * is carried and one that is the base is not, with no question asked.
 */
export async function placeOutside(
  outside: readonly OutsideIssue[],
  base: string | null,
  head: string,
  ask: Ask | { why: string },
): Promise<OutsideRead> {
  const read: OutsideRead = { carried: [], unchecked: [] };
  const open: Array<OutsideIssue & { commit: string }> = [];
  for (const issue of outside) {
    const commit = issue.commit?.trim().toLowerCase() ?? '';
    if (commit === '') {
      read.unchecked.push({ issueKey: issue.key, commit: null, why: 'its merge names no commit' });
    } else if (commit === head.toLowerCase()) read.carried.push({ ...issue, commit });
    else if (base === null || commit !== base.toLowerCase()) open.push({ ...issue, commit });
  }
  if (open.length === 0) return read;
  const unchecked = (issue: OutsideIssue & { commit: string }, why: string) =>
    read.unchecked.push({ issueKey: issue.key, commit: issue.commit, why });
  if (typeof ask !== 'function') {
    for (const issue of open) unchecked(issue, ask.why);
    return read;
  }
  const pairs: AncestryPair[] = open.flatMap((i) => [
    { commit: i.commit, release: head },
    ...(base === null ? [] : [{ commit: i.commit, release: base }]),
  ]);
  const answers = await ask(pairs);
  if ('silent' in answers) {
    for (const issue of open) unchecked(issue, `nobody read its ancestry: ${answers.silent}`);
    return read;
  }
  for (const issue of open) {
    const inHead = answers.get(pairKey({ commit: issue.commit, release: head }));
    const inBase =
      base === null ? false : answers.get(pairKey({ commit: issue.commit, release: base }));
    // not in the head, or already in the base: this range does not carry it, whatever else is unread
    if (inHead === false || inBase === true) continue;
    if (inHead === true && inBase === false) {
      read.carried.push(issue);
      continue;
    }
    const why = [inHead, inBase].find((a) => typeof a === 'object')?.unread ?? 'no answer';
    unchecked(issue, `whether ${short(head)} carries it could not be read: ${why}`);
  }
  return read;
}

/** The gate issues of `projectId` the release run `runId` does not claim, oldest landing first. */
export async function outsideGateIssues(projectId: string, runId: string): Promise<OutsideIssue[]> {
  const rows = await db
    .select({ id: issues.id, commit: issues.mergedCommitSha })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.status, RELEASE_GATE_STATUS),
        or(isNull(issues.releaseBatchRunId), ne(issues.releaseBatchRunId, runId)),
      ),
    )
    .orderBy(issues.mergedAt, issues.id);
  const keys = await issueDisplayIds(rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, key: keys.get(r.id) ?? r.id, commit: r.commit }));
}

/** What `head` carries of the gate outside the roster of `runId`, read by the project's ancestry. */
export async function readOutsideLandings(
  projectId: string,
  runId: string,
  base: string | null,
  head: string,
): Promise<OutsideRead> {
  const outside = await outsideGateIssues(projectId, runId);
  if (outside.length === 0) return { carried: [], unchecked: [] };
  const source = await ancestrySourceFor(projectId);
  const ask = source.kind === 'none' ? { why: source.why } : source.reader.ask.bind(source.reader);
  return placeOutside(outside, base, head, ask);
}

/**
 * The unchecked gate issues a range reading kept; null where it was kept before ISS-962 checked any,
 * or holds an entry that is not one, which says the same: the list cannot be trusted whole.
 */
export function uncheckedOf(value: unknown): ReleaseRangeUnchecked[] | null {
  if (!Array.isArray(value)) return null;
  const out: ReleaseRangeUnchecked[] = [];
  for (const u of value) {
    const { issueKey, commit, why } = (u ?? {}) as Record<string, unknown>;
    if (typeof issueKey !== 'string' || typeof why !== 'string') return null;
    if (commit !== null && typeof commit !== 'string') return null;
    out.push({ issueKey, commit, why });
  }
  return out;
}

/** The refusal's sentence: the issues the head carries, and what the run does instead. */
export function outsideSentence(
  head: string,
  version: string | null,
  carried: readonly OutsideIssue[],
): string {
  const n = carried.length;
  const named = carried.map((i) => `${i.key} (landed at ${short(i.commit ?? '')})`).join(', ');
  const tag = version ? `v${version}` : 'this release';
  return (
    `${short(head)} carries the landing of ${n} ${agrees(n, 'issue', 'issues')} waiting at the release gate outside this release's roster: ${named}. ` +
    `Tagged there, ${tag} would ship ${agrees(n, 'it', 'them')} with no record, release note, criteria weighing or approval of ${agrees(n, 'it', 'them')}, so nothing is kept or tagged. ` +
    `Cut the release commit from a head that holds the roster's own landings and none of ${agrees(n, 'this', 'these')}, and report its range again; ` +
    `where one landed below a roster landing, so no such head exists, do not deploy: abort this batch, and the next cut weighs ${agrees(n, 'it', 'them')} with the roster.`
  );
}
