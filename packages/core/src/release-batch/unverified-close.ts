// An unverified close says so on each issue, so it never reads as a verified one: sid-desk ISS-191
// closed 42 issues on a release that was not running (ISS-1042, ISS-1321).

import { and, eq } from 'drizzle-orm';
import { postIssueNoticeOnce } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { TransitionActor } from '../issues/index.js';
import { issueArchiveSide } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { writeRunMetadata } from '../pipeline/index.js';
import type { ReleaseVerification } from './plan.js';

/** The line a reader, or a query, finds an unverified close by. One per issue per release run. */
function unverifiedMarker(runId: string): string {
  return `release-verification: unverified ${runId}`;
}

function unverifiedCloseNote(runId: string, commit: string | null): string {
  const reported = commit
    ? `The release reported shipping \`${commit}\`, and nothing checked that it is serving.`
    : 'The release reported no commit, so nothing names what it shipped.';
  return [
    '**This issue is being closed by a release that was not verified.**',
    '',
    `This project's production environment declares no runtime probe identifying the source, so nothing read the production deployment. ${reported}`,
    '',
    'Look at the production deployment for this change, and reopen this issue if it is not there. If it can report the commit it serves, declaring that endpoint under the production environment\'s `verification.runtime` (with `identifies: "source"`) in the project document makes the releases after that verified.',
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
    // The row lock serialises two workers of one attempt. An archived issue's close is refused by
    // the transition, so it takes no note saying it is being closed.
    const wrote = await db.transaction(async (tx) => {
      const [live] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issueId), ...issueArchiveSide(false)))
        .for('update');
      if (!live) return false;
      const posted = await postIssueNoticeOnce({ issueId, ...author, body, marker }, tx);
      return posted !== null;
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

/** The run carries how its close was proved, which may differ from how it opened. */
export async function stampRunVerification(
  runId: string,
  kind: ReleaseVerification,
): Promise<void> {
  await writeRunMetadata(runId, {
    merge: { verification: kind },
    touch: false,
  });
}
