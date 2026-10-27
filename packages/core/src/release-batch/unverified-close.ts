// An unverified close says so on each issue, so it never reads as a verified one: sid-desk ISS-191
// closed 42 issues on a release that was not running (ISS-1042, ISS-1321). The note is written in
// the close's own transaction, so an issue whose close is refused carries none (ISS-1421 r40).

import { and, eq, like, sql } from 'drizzle-orm';
import { postSystemComment } from '../comments/system-write.js';
import { db, type Tx } from '../db/client.js';
import { comments, issues, pipelineRuns } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { issueArchiveSide } from '../issues/archive.js';
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
    ? `The release reported deploying \`${commit}\`, and nothing checked that it is serving.`
    : 'The release reported no commit, so nothing names what it put live.';
  const partial = unread.length > 0;
  return [
    partial
      ? '**This issue was closed by a release that was verified at only some of its deploy targets.**'
      : '**This issue was closed by a release that was not verified.**',
    '',
    partial
      ? `Nothing read what these live deploy targets serve, because none declares a verify probe: ${unread.join(', ')}. The deploy targets that do declare one were read and confirmed.`
      : `This project declares no verify probe, so nothing read the live deployment. ${reported}`,
    '',
    "Look at the live deployment for this change, and reopen this issue if it is not there. If your live deployment can report the commit it serves, give the live deploy target a verify probe on the project's Integrations tab, and the releases after that are verified.",
    '',
    `\`${unverifiedMarker(runId)}\``,
  ].join('\n');
}

function authorOf(actor: TransitionActor): { authorId: string; authorDeviceId: string | null } {
  return actor.type === 'user'
    ? { authorId: actor.id, authorDeviceId: null }
    : { authorId: actor.ownerId, authorDeviceId: actor.id };
}

/**
 * Inside the close's own transaction, before it writes: the note commits only with the close, and a
 * failed write throws, so a close that cannot say it was unverified does not happen. False where the
 * issue already carries this run's note, or is archived (whose close the transition refuses).
 */
export async function noteUnverifiedClose(
  tx: Tx,
  args: {
    runId: string;
    issueId: string;
    actor: TransitionActor;
    commit: string | null;
    unread?: readonly string[] | undefined;
  },
): Promise<boolean> {
  const marker = unverifiedMarker(args.runId);
  // The row lock serialises two workers of one attempt.
  const [live] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, args.issueId), ...issueArchiveSide(false)))
    .for('update');
  if (!live) return false;
  const [already] = await tx
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.issueId, args.issueId), like(comments.body, `%${marker}%`)))
    .limit(1);
  if (already) return false;
  const body = unverifiedCloseNote(args.runId, args.commit, args.unread);
  await postSystemComment(
    { issueId: args.issueId, ...authorOf(args.actor), body, announces: 'release' },
    tx,
  );
  return true;
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
