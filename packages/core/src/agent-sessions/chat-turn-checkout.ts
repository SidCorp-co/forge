// Where a chat turn runs (ISS-1101): the checkout the turn's device binding names now, read on
// every turn. A session's stored path is only where it ran last; a box rebound to another checkout
// moves the session there, said on its transcript, where it used to keep the old path for good and
// fail every turn in a checkout the box no longer had.

import { randomUUID } from 'node:crypto';
import type { agentSessions } from '../db/schema.js';
import { resolveSessionRepoPathForDevice } from '../lib/device-pool.js';
import type { RefusalError } from '../lib/refusal.js';
import { refuseSession } from './refusals.js';
import type { TranscriptEntry } from './turns-helpers.js';

type AgentSessionRow = typeof agentSessions.$inferSelect;

/** A remote turn runs in its device binding's checkout; a binding that names none is refused by name. */
function checkoutUnbound(projectId: string, deviceId: string | null): RefusalError {
  return refuseSession(
    'CHECKOUT_UNBOUND',
    `device ${deviceId ?? '(none)'}'s binding to project ${projectId} names no checkout, so no turn runs there. The binding is the only place a checkout is named: set it with \`forge-runner bind <slug> --path <dir>\` on the box, or PATCH /api/projects/${projectId}/runners/:runnerId { repoPath }.`,
  );
}

/**
 * The checkout a turn runs in: the one its device's binding names now, read on every turn. The
 * session's stored path is only what it ran in last: a box rebound to another checkout moves the
 * session there, said by `movedFrom` (ISS-1101), where it used to keep the old path for good.
 */
export async function turnCheckout(
  session: Pick<AgentSessionRow, 'repoPath' | 'deviceId'>,
  projectId: string,
  deviceId: string,
  migrated: boolean,
): Promise<{ repoPath: string; movedFrom: string | null }> {
  const repoPath = await resolveSessionRepoPathForDevice(projectId, deviceId);
  if (!repoPath) throw checkoutUnbound(projectId, deviceId);
  return { repoPath, movedFrom: checkoutMovedFrom(session, deviceId, repoPath, migrated) };
}

/**
 * The checkout a session ran in on `deviceId` when that box's binding now names `bound`, another;
 * null where it runs where it ran, or lands on another box (a migration starts fresh anyway).
 */
export function checkoutMovedFrom(
  session: Pick<AgentSessionRow, 'repoPath' | 'deviceId'>,
  deviceId: string,
  bound: string | null,
  migrated = false,
): string | null {
  const sameBox = !migrated && deviceId === (session.deviceId ?? null);
  return sameBox && bound && session.repoPath && session.repoPath !== bound
    ? session.repoPath
    : null;
}

/** The line a moved session's transcript carries before the turn that moved it. */
export function movedNotice(from: string, to: string, at: Date): TranscriptEntry {
  return {
    id: randomUUID(),
    type: 'system',
    content: `This session ran in the checkout ${from}; its binding names ${to} now, so this turn and every one after it run there.`,
    timestamp: at.getTime(),
  };
}
