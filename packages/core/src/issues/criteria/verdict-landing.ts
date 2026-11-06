// A commit verdict on an issue whose merge is recorded is held to that landing (ISS-981, catalog-api
// FB-501): a verdict at a commit that is neither the landing, nor a later commit holding it, nor an
// earlier commit it descends from judged a revision the landing does not hold, and the weighing
// (`release-batch/landed-build-holds.ts`) then counted it for nothing in silence. Where no merge is
// recorded, or the mark names no commit, a commit verdict is taken as before: a builder records at
// its branch commit before it lands, and the landing carries that verdict (ISS-845).

import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { commitPlacedOnLanding } from '../commit-placement.js';
import { markedCommitsOf } from '../mark-trail.js';
import type { VerdictRefusal } from './verdict-input.js';

/** Why a commit verdict may not be taken against the issue's recorded landing; null where it may. */
export async function offLandingFault(
  tx: Pick<Tx, 'execute'>,
  issue: { id: string; projectId: string },
  criterion: number,
  sha: string,
): Promise<VerdictRefusal | null> {
  const [merged] = (await tx.execute(sql`
    SELECT merged_target AS target FROM issues WHERE id = ${issue.id} AND merged_at IS NOT NULL
  `)) as unknown as Array<{ target: string | null }>;
  if (!merged) return null;
  const landing = (await markedCommitsOf([issue.id], tx)).get(issue.id)?.sha ?? null;
  if (!landing) return null;
  const placed = await commitPlacedOnLanding(issue.projectId, landing, sha);
  if ('placed' in placed && placed.placed) return null;
  const on = merged.target ? ` on \`${merged.target}\`` : '';
  const counts = `A commit verdict on this issue counts at its landing \`${landing}\` itself, at a later commit${on} that holds it (the build the testing environment or production serves), or at an earlier commit the landing descends from (the branch head a builder judged before landing)`;
  if ('unread' in placed) {
    return {
      code: 'VERDICT_COMMIT_UNPLACED',
      criterion,
      path: '/identity/sha',
      detail: `criterion ${criterion}'s verdict names commit \`${sha}\`, and this issue's recorded landing is \`${landing}\`: whether either holds the other could not be read (${placed.unread}), so it is not taken as one that counts. ${counts}. Nothing was written.`,
    };
  }
  return {
    code: 'VERDICT_COMMIT_OFF_LANDING',
    criterion,
    path: '/identity/sha',
    detail: `criterion ${criterion}'s verdict names commit \`${sha}\`, which neither holds this issue's recorded landing \`${landing}\` nor is a commit it descends from: it judged a revision the landing does not hold, and would count for nothing. ${counts}. Nothing was written.`,
  };
}
