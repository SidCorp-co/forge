// Scheduled checks a channel agent runs (REQ-77 BC-13): the AdminHub morning check, and any other the
// binding's `agent.checks` names. Each check fires once a day at its time (UTC) as a message core
// writes into its group's record, thread `check:<name>:<date>`, and goes to the agent like any
// message. The agent answers it with `check_result`: a finding core posts as one message in the
// group's report thread (ISS-1227, `report-thread.ts`), never its top level, or none, and nothing is
// posted. One result per firing, whoever sends it; a check turn that fails posts nothing in the group.

import type { SupportCheck, SupportGrants } from '@forge/contracts/support';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions, supportRooms } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { deliverWaiting } from './dispatch.js';
import { grantsOf, readersOfConfig, supportConfigOf } from './grants.js';
import { projectsInScope } from './ops-scope.js';
import { no, type Outcome } from './outcome.js';
import { reportThreadFor } from './report-thread.js';
import { checkThreadOf } from './rules.js';
import { screenForThread } from './screen.js';
import { insertAction, type RoomRow } from './store.js';
import { postInThread, scrubbedForRoom, topLevelThreadOf } from './thread.js';

/** `YYYY-MM-DD` and `HH:MM` of `now` in UTC. */
function utcParts(now: Date): { day: string; time: string } {
  const iso = now.toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/**
 * What the agent is handed when a check fires: the tracker reads over every project it follows
 * (ISS-874), and the production reads the room's grant declares (ISS-871), by name only.
 */
export function checkNote(
  check: SupportCheck,
  thread: string,
  grants: SupportGrants,
  projects: readonly string[],
): string {
  const reads = grants.abilities.includes('ops_reads') ? (grants.reads ?? []) : [];
  const production = reads.length
    ? ` Read production with support.read { name, args?, check: "${thread}" }, through the reads this room is granted: ${reads.map((r) => r.name).join(', ')} (your brief lists what each takes).`
    : '';
  return [
    `Scheduled check \`${check.name}\` for channel ${check.rid}:`,
    check.ask,
    `Answer it with support.check_result { check: "${thread}", finding }: the one finding to post in the channel when something is wrong, or finding null when nothing is, and nothing is posted. Write the finding as the persona speaks, its language and its length. Read the tracker with support.issues, support.releases and support.requirements { project }, for each project you follow: ${projects.join(', ')}.${production} Post nothing else for this check.`,
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
    const config = await supportConfigOf(room);
    const checks = config?.checks ?? [];
    const due = dueChecks(checks, room.rid, now);
    if (due.length === 0) continue;
    const projects = (await projectsInScope(room)).map((p) => p.slug);
    for (const { check, thread } of due) {
      const row = await insertAction({
        roomId: room.id,
        projectId: room.projectId,
        conversationId: null,
        thread,
        kind: 'message_in',
        actorKind: 'core',
        input: {
          note: checkNote(check, thread, grantsOf(config), projects),
          check: check.name,
        },
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
export async function firingOf(room: RoomRow, thread: string): Promise<boolean> {
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
 * The thread a finding goes in: the project's own of a shared operations room (ISS-933), else the
 * room's report thread, opened now where none stands (ISS-1227); never the top level. A room with
 * neither refuses by name.
 */
async function findingThreadOf(room: RoomRow, finding: string): Promise<Outcome<string>> {
  const own = await topLevelThreadOf(room);
  if (!own.ok) return own;
  if (own.value) return { ok: true, value: own.value };
  return reportThreadFor(room, [finding], { named: false });
}

/** A finding refused for want of a thread, recorded on the check's firing; nothing was posted. */
async function recordUnposted(
  room: RoomRow,
  check: string,
  out: { ok: false; refusals: { code: string; detail: string }[] },
): Promise<void> {
  const [refusal] = out.refusals;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: check,
    kind: 'refused',
    actorKind: 'core',
    tool: 'check_result',
    output: { code: refusal?.code, detail: refusal?.detail, posted: false },
  });
}

/**
 * The agent's one result for one firing of a check: a finding is posted as one message in the
 * room's report thread (`findingThreadOf`), screened for its readers; none posts nothing. A second
 * result for the same firing is refused, the first already holding the firing's one result.
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
  const door = readersOfConfig(room, config) === 'team' ? 'operations-reply' : 'support-reply';
  const admitted =
    finding === null
      ? null
      : await screenForThread(room, null, input.check, finding, door, 'check_result');
  if (admitted && !admitted.ok) return admitted;
  // where the finding lands, read before the firing's one result is claimed: a room with no thread
  // to take it refuses, recorded on the check, and the check can still be answered (ISS-933, ISS-1227)
  const to = admitted ? await findingThreadOf(room, admitted.value.text) : null;
  if (to && !to.ok) {
    await recordUnposted(room, input.check, to);
    return to;
  }
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
  if (!admitted || !to) return { ok: true, value: { posted: null } };
  const posted = await postInThread({
    room,
    thread: to.value,
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
