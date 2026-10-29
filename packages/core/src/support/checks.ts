// Scheduled checks a channel agent runs (REQ-77 BC-13): the AdminHub morning check, and any other the
// binding's `agent.checks` names. Each check fires once a day at its time (UTC) as a message core
// writes into its group's record, thread `check:<name>:<date>`, and goes to the agent like any
// message. The agent answers it with `check_result`: a finding core posts as one message at the
// group's top level, or none, and nothing is posted. One result per firing, whoever sends it; a
// check turn that fails posts nothing in the group.

import type { SupportCheck } from '@forge/contracts/support';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions, supportRooms } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { deliverWaiting } from './dispatch.js';
import { supportConfigOf } from './grants.js';
import { no, type Outcome } from './outcome.js';
import { checkThreadOf } from './rules.js';
import { screenForThread } from './screen.js';
import { insertAction, type RoomRow } from './store.js';
import { postTopLevel, scrubbedForRoom } from './thread.js';

/** `YYYY-MM-DD` and `HH:MM` of `now` in UTC. */
function utcParts(now: Date): { day: string; time: string } {
  const iso = now.toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** What the agent is handed when a check fires. */
function checkNote(check: SupportCheck, thread: string): string {
  return [
    `Scheduled check \`${check.name}\` for channel ${check.rid}:`,
    check.ask,
    `Answer it with support.check_result { check: "${thread}", finding }: the one finding to post in the channel when something is wrong, or finding null when nothing is, and nothing is posted. Post nothing else for this check.`,
  ].join('\n\n');
}

/** The checks due in this room now: its group's, past their time today. */
export function dueChecks(
  checks: readonly SupportCheck[],
  rid: string,
  now: Date,
): { check: SupportCheck; thread: string }[] {
  const { day, time } = utcParts(now);
  return checks
    .filter((c) => c.rid === rid && c.at <= time)
    .map((check) => ({ check, thread: checkThreadOf(check.name, day) }));
}

/**
 * The checks sweep (a process timer, every minute): each check due today and not fired yet is
 * recorded once — the firing's `message_in` is unique per room and thread, so two cores fire it once —
 * and handed to the agent at once.
 */
export async function fireDueChecks(now = new Date()): Promise<number> {
  const rooms = await db
    .select()
    .from(supportRooms)
    .where(and(eq(supportRooms.kind, 'agent'), isNotNull(supportRooms.sessionId)));
  let fired = 0;
  for (const room of rooms) {
    const checks = (await supportConfigOf(room))?.checks ?? [];
    for (const { check, thread } of dueChecks(checks, room.rid, now)) {
      const row = await insertAction({
        roomId: room.id,
        projectId: room.projectId,
        conversationId: null,
        thread,
        kind: 'message_in',
        actorKind: 'core',
        input: { note: checkNote(check, thread), check: check.name },
        externalId: thread,
      });
      if (!row) continue;
      fired += 1;
      await deliverWaiting(room.id).catch((err) =>
        logger.error({ err, roomId: room.id, thread }, 'support: a fired check was not handed on'),
      );
    }
  }
  return fired;
}

/** The firing a result names, in this room: a message core wrote under that check thread. */
async function firingOf(room: RoomRow, thread: string): Promise<boolean> {
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'core'),
        eq(supportActions.thread, thread),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The agent's one result for one firing of a check: a finding is posted as one message at the
 * group's top level, screened for its readers; none posts nothing. A second result for the same
 * firing is refused, the first already holding the firing's one result.
 */
export async function checkResult(
  room: RoomRow,
  input: { check: string; finding: string | null },
): Promise<Outcome<{ posted: string | null }>> {
  if (!(await firingOf(room, input.check))) {
    return no(
      'SUPPORT_CHECK_UNKNOWN',
      '/check',
      `no scheduled check fired as ${input.check} in this group; answer the check thread you were handed`,
    );
  }
  const config = await supportConfigOf(room);
  const finding = input.finding === null ? null : await scrubbedForRoom(room, input.finding);
  // screened before the firing's one result is taken, so a finding the screen refuses can be rewritten
  const door = config?.readers === 'team' ? 'operations-reply' : 'support-reply';
  const admitted =
    finding === null
      ? null
      : await screenForThread(room, null, input.check, finding, door, 'check_result');
  if (admitted && !admitted.ok) return admitted;
  const claimed = await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: input.check,
    kind: 'check_result',
    actorKind: 'session',
    input: { finding },
  });
  if (!claimed) {
    return no(
      'SUPPORT_CHECK_ANSWERED',
      '/check',
      `${input.check} already has its one result; a check posts at most one finding, and nothing was posted`,
    );
  }
  if (!admitted) return { ok: true, value: { posted: null } };
  const posted = await postTopLevel({
    room,
    text: admitted.value.text,
    proof: admitted.value.proof,
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: input.check,
    kind: 'check_posted',
    actorKind: 'core',
    input: { text: admitted.value.text },
    externalId: posted.messageId,
  });
  return { ok: true, value: { posted: posted.messageId } };
}
