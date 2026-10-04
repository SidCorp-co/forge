/**
 * A session a schedule starts runs as a person (ISS-30): the schedule's owner on a cron firing,
 * the person who pressed run on a manual one. It goes only to a box whose runner carries the
 * token of a first turn (`turnCredential`); the token is minted for that person, cut to the box
 * holder's role and fenced to the project and the box, and dies when the session stops
 * (migration 0324). A run that may not act as its person is refused by name and recorded as its
 * schedule's failed run — never run with someone else's reach.
 *
 * A scheduled session sends no follow-up, so `followUpCredential` is not asked of its box: a
 * person who continues it from the web goes through `resolveInteractiveClient`, which asks it of
 * whichever box takes that turn.
 */

import { eq } from 'drizzle-orm';
import {
  type InteractiveAuthority,
  noTurnCredentialDeviceReason,
  pickTurnCredentialDevice,
  RUNNER_OUTDATED_REFUSAL,
  readBoxAuthority,
  type SessionAsker,
  type SessionRefusal,
  sessionRoleRefusal,
  transitionSessions,
} from '../agent-sessions/index.js';
import { turnAuthorityRefusalOf } from '../credentials/turn-credential.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { logger } from '../observability/logger.js';

type AgentSessionRow = typeof agentSessions.$inferSelect;

const SCHEDULE_OWNER_GONE_REFUSAL: SessionRefusal = {
  code: 'SCHEDULE_OWNER_GONE',
  message:
    'This schedule has no owner to run as: the account that saved it is gone. A project admin can save the schedule again to run it as themselves.',
};

type ScheduledAuthorityOutcome =
  | { kind: 'authorised'; authority: NonNullable<InteractiveAuthority> }
  | { kind: 'refused'; refusal: SessionRefusal }
  | { kind: 'no-device' };

/** Who a firing acts as: the person who pressed run, else the schedule's owner, else nobody. */
export function scheduledAsker(
  actor: SessionAsker | undefined,
  ownerId: string | null | undefined,
): SessionAsker | null {
  if (actor) return actor;
  return ownerId ? { userId: ownerId, viaTokenId: null } : null;
}

/**
 * Whether `asker` may be acted as on a free box of the project, read now. The person's own role
 * is read before any box, so a refusal that is theirs is named even where no box is online.
 */
export async function authorizeScheduledRun(args: {
  projectId: string;
  asker: SessionAsker | null;
  excludeDeviceIds?: string[];
}): Promise<ScheduledAuthorityOutcome> {
  const { asker, projectId } = args;
  const exclude = args.excludeDeviceIds ?? [];
  if (!asker) return { kind: 'refused', refusal: SCHEDULE_OWNER_GONE_REFUSAL };
  const roleRefusal = sessionRoleRefusal(await effectiveProjectRole(asker.userId, projectId));
  if (roleRefusal) return { kind: 'refused', refusal: roleRefusal };
  const deviceId = await pickTurnCredentialDevice(projectId, exclude);
  if (!deviceId) {
    return (await noTurnCredentialDeviceReason(projectId, exclude)) === 'runner-outdated'
      ? { kind: 'refused', refusal: RUNNER_OUTDATED_REFUSAL }
      : { kind: 'no-device' };
  }
  const read = await readBoxAuthority({ deviceId, projectId, asker });
  return read.ok
    ? { kind: 'authorised', authority: read.authority }
    : { kind: 'refused', refusal: read.refusal };
}

/** A mint that finds nothing to grant refuses inside the dispatch; it is the run's refusal too. */
export function refusalOfMint(err: unknown): SessionRefusal | null {
  const refused = turnAuthorityRefusalOf(err);
  return refused ? { code: refused.code, message: refused.message } : null;
}

/**
 * Record a refused firing where its schedule's failures are read: the run's session, failed with
 * the refusal's code leading its detail, and the schedule's last run pointing at it.
 */
export async function recordRefusedRun(args: {
  session: AgentSessionRow;
  scheduleId: string;
  refusal: SessionRefusal;
}): Promise<void> {
  const { session, scheduleId, refusal } = args;
  logger.warn(
    { sessionId: session.id, scheduleId, code: refusal.code },
    'schedule.dispatch: the run may not act as its person; refused',
  );
  await transitionSessions(db, {
    to: 'failed',
    set: {
      failureReason: 'session_authority_refused',
      failureDetail: `${refusal.code}: ${refusal.message}`,
    },
    where: eq(agentSessions.id, session.id),
    reason: 'session_authority_refused',
    actor: { type: 'system' },
    source: 'schedule',
  });
}

/** A run whose frame never reached its box is failed, never left `idle` for the sweeper to guess at. */
export async function failUndeliveredRun(session: AgentSessionRow): Promise<void> {
  try {
    await transitionSessions(db, {
      to: 'failed',
      set: { failureReason: 'ws_publish_failed' },
      where: eq(agentSessions.id, session.id),
      reason: 'ws-publish-failed',
      actor: { type: 'system' },
      source: 'schedule',
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id },
      'schedule.dispatch: failed to mark session failed after dispatch failure',
    );
  }
}
