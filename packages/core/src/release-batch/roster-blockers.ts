// What a release's roster owes before it may be closed (ISS-1127): the shipped-in record, the release
// record's notes and, at the record door, a merge mark for each issue. Read at once and reported in the
// order the doors refuse in (`blockers.ts:collectReleaseBlockers`, ISS-1070 r17).

import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { issueDisplayIds, landingShortfall, releaseRecordGaps } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { readGateProfile } from '../project-config/index.js';
import { blocker, collected, evaluate, settledValue } from './blocker-kit.js';
import type { ReleaseBlocker, ReleaseDoor } from './blocker-sentences.js';
import { releaseRecordBlocker } from './record-blocker.js';
import { shippedInBlocker } from './shipped-in.js';

/** `ISS-nn` for each, in the order given, so a refusal names the rows it is about (ISS-1346). A
 *  failed read costs the names and not the reason: the refusal still counts them, and says so. */
async function namedAs(ids: string[]): Promise<string[]> {
  try {
    const shown = await issueDisplayIds(ids);
    return ids.map((id) => shown.get(id) ?? id);
  } catch (err) {
    logger.warn({ err }, 'release-blockers: the refused issues could not be named');
    return [];
  }
}

/** What the roster owes before it may be closed: a note, and a merge. */
export async function rosterBlockers(
  projectId: string,
  door: ReleaseDoor,
  issueIds: string[],
  out: ReleaseBlocker[],
): Promise<void> {
  if (issueIds.length === 0) return;
  // the three are read at once and reported in this order (ISS-1070 r17)
  const [shippedIn, record, merged] = await Promise.all([
    door === 'record'
      ? null
      : collected(async (o) => {
          const owed = await evaluate('shipped-in', () => shippedInBlocker(projectId, issueIds), o);
          if (owed) o.push(owed);
        }),
    collected((o) => recordBlocker(projectId, issueIds, o)),
    door === 'record' ? collected((o) => unmergedBlocker(issueIds, o)) : null,
  ]);
  out.push(...(shippedIn?.out ?? []), ...record.out, ...(merged?.out ?? []));
}

/** What the roster's release record owes: its notes, as the gate profile weighs them. */
async function recordBlocker(projectId: string, issueIds: string[], out: ReleaseBlocker[]) {
  const gaps = await evaluate(
    'release-record',
    async () => {
      const [gaps, profile] = await Promise.allSettled([
        releaseRecordGaps(issueIds),
        readGateProfile(projectId),
      ]);
      return { gaps: settledValue(gaps), profile: settledValue(profile) };
    },
    out,
  );
  const owed = gaps && (await releaseRecordBlocker(gaps.gaps, namedAs, gaps.profile));
  if (owed) out.push(owed);
}

/** The roster issues no merge mark stands for, at the record door. */
async function unmergedBlocker(issueIds: string[], out: ReleaseBlocker[]) {
  // Unmerged means what the close would refuse: no mark at all (`landing-evidence.ts`, ISS-1017).
  // Judged inside the read, so a query that fails is this check unevaluated, by name.
  const unmerged = await evaluate(
    'merged',
    async () => {
      const rows = await db
        .select({
          id: issues.id,
          mergedAt: issues.mergedAt,
          mergedCommitSha: issues.mergedCommitSha,
          mergedLanding: issues.mergedLanding,
        })
        .from(issues)
        .where(inArray(issues.id, issueIds));
      return rows.filter((r) => landingShortfall(r) !== null);
    },
    out,
  );
  if (!unmerged) return;
  if (unmerged.length > 0) {
    const ids = unmerged.map((r) => r.id);
    const displayIds = await namedAs(ids);
    out.push(blocker('RELEASE_WORK_UNMERGED', { issueIds: ids, displayIds }));
  }
}
