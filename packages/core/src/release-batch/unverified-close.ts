// An unverified close says so on each issue, so it never reads as a verified one: sid-desk ISS-191
// closed 42 issues on a release that was not running (ISS-1042, ISS-1321).

import { and, eq, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { logger } from '../logger.js';

/** The line a reader, or a query, finds an unverified close by. One per issue per release run. */
export function unverifiedMarker(runId: string): string {
  return `release-verification: unverified ${runId}`;
}

export function unverifiedCloseNote(runId: string, commit: string | null): string {
  const at = commit ? ` at \`${commit}\`` : '';
  return [
    '**This issue is being closed by a release that was not verified.**',
    '',
    `This project declares no live verify probe, so nothing read the deployment, and only the release run's own account says the change is serving${at}. Declare \`environments.live.commitUrl\` (with \`commitPath\`), or a \`verify\` on the live deploy binding, and the releases after that are verified.`,
    '',
    `\`${unverifiedMarker(runId)}\``,
  ].join('\n');
}

function authorOf(actor: TransitionActor): { authorId: string; authorDeviceId: string | null } {
  return actor.type === 'user'
    ? { authorId: actor.id, authorDeviceId: null }
    : { authorId: actor.ownerId, authorDeviceId: actor.id };
}

/** Before each close, on every issue not already carrying this run's marker. A failed write
 *  throws: a close that cannot say it was unverified does not happen. */
export async function noteUnverifiedCloses(args: {
  runId: string;
  issueIds: readonly string[];
  actor: TransitionActor;
  commit: string | null;
}): Promise<number> {
  const marker = unverifiedMarker(args.runId);
  const body = unverifiedCloseNote(args.runId, args.commit);
  const author = authorOf(args.actor);
  let written = 0;
  for (const issueId of args.issueIds) {
    // The issue row's lock serialises two workers of one attempt, so the check and the insert
    // cannot interleave.
    const wrote = await db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for('update');
      const [already] = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(and(eq(comments.issueId, issueId), like(comments.body, `%${marker}%`)))
        .limit(1);
      if (already) return false;
      await tx.insert(comments).values({ issueId, ...author, body });
      return true;
    });
    if (wrote) written += 1;
  }
  if (written > 0) {
    logger.warn(
      { runId: args.runId, written },
      'release-batch: closing a roster no probe verified; each issue says so',
    );
  }
  return written;
}
