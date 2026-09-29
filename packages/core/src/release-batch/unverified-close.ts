// What an unverified release leaves on each issue it closes (ISS-1321).
//
// A release on a project that declares no verify probe closes its roster on the release agent's
// word, which is the shape sid-desk ISS-191 was found in: 42 issues closed on a release that was
// not running. The owner ruled on 2026-09-29 that the absence is reported on the release rather
// than made a condition of it, so this note is the half that keeps a reader able to tell an
// unverified close from a verified one.

import { and, eq, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
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

/**
 * Write the note on every issue named that does not already carry this run's marker, BEFORE the
 * issue closes. A pass that resumes an attempt writes none twice, and a later run writes its own.
 * A write that fails throws: a close that cannot say it was unverified does not happen.
 */
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
    const [already] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.issueId, issueId), like(comments.body, `%${marker}%`)))
      .limit(1);
    if (already) continue;
    await db.insert(comments).values({ issueId, ...author, body });
    written += 1;
  }
  if (written > 0) {
    logger.warn(
      { runId: args.runId, written },
      'release-batch: closing a roster no probe verified; each issue says so',
    );
  }
  return written;
}
