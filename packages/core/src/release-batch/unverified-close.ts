// An unverified close says so on each issue, so it never reads as a verified one: sid-desk ISS-191
// closed 42 issues on a release that was not running (ISS-1042, ISS-1321).

import { and, eq, like, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues, pipelineRuns } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { issueArchiveSide } from '../issues/archive.js';
import { logger } from '../logger.js';
import type { ReleaseVerification } from './plan.js';

/** The line a reader, or a query, finds an unverified close by. One per issue per release run. */
export function unverifiedMarker(runId: string): string {
  return `release-verification: unverified ${runId}`;
}

/**
 * `unread` names the live bindings that declare no probe where others do: the release was verified
 * at the rest, and these were deployed with nothing reading what they serve.
 */
export function unverifiedCloseNote(
  runId: string,
  commit: string | null,
  unread: readonly string[] = [],
): string {
  const reported = commit
    ? `The release reported shipping \`${commit}\`, and nothing checked that it is serving.`
    : 'The release reported no commit, so nothing names what it shipped.';
  const partial = unread.length > 0;
  return [
    partial
      ? '**This issue is being closed by a release that was verified at only some of its deploy bindings.**'
      : '**This issue is being closed by a release that was not verified.**',
    '',
    partial
      ? `Nothing read what these live deploy bindings serve, because none declares a verify probe: ${unread.join(', ')}. The bindings that do declare one were read and confirmed.`
      : `This project declares no verify probe, so nothing read the live deployment. ${reported}`,
    '',
    'Look at the live deployment for this change, and reopen this issue if it is not there. If your live deployment can report the commit it serves, declaring `environments.live.commitUrl` (with `commitPath`), or a `verify` on the live deploy binding, makes the releases after that verified.',
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
  unread?: readonly string[] | undefined;
}): Promise<number> {
  const marker = unverifiedMarker(args.runId);
  const body = unverifiedCloseNote(args.runId, args.commit, args.unread);
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

/** The run carries how its close was proved, which may differ from how it opened. */
export async function stampRunVerification(
  runId: string,
  kind: ReleaseVerification,
): Promise<void> {
  await db
    .update(pipelineRuns)
    .set({
      metadata: sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || ${JSON.stringify({ verification: kind })}::jsonb`,
    })
    .where(eq(pipelineRuns.id, runId));
}
