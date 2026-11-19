// The agent's one post for a morning reminder (ISS-1343): `support.check_result` on the reminder's
// firing (`wait-reminder.ts`). Its words are the agent's; core screens them as every line of the
// technical channel is screened, re-reads the project's waits first so a wait the record settled
// since the reminder was handed is never posted as waiting (refused by name, naming it), and posts it
// once: in the project's own thread of the shared operations room, or in a direct message to the
// owner (`technical-channel.ts`). A finding of null posts nothing and still takes the morning's result.

import type { ProvenMessage } from '@forge/contracts/messaging';
import { eq } from 'drizzle-orm';
import { outsideTokenScope } from '../credentials/pat-scope.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { findProjectSlugs, projectName } from '../projects/index.js';
import { no, type Outcome } from './outcome.js';
import { projectThreadFor } from './project-thread.js';
import { screenForThread } from './screen.js';
import { insertAction, type RoomRow } from './store.js';
import { destinationOf, postTo, technicalLine } from './technical-channel.js';
import { postInThread, roomAuth, scrubbedForRoom } from './thread.js';
import type { ReminderFiring } from './wait-reminder.js';
import { projectWaits, type Wait } from './wait-reminder-waits.js';

const TOOL = 'check_result';

/**
 * The waits a finding links that the record settled since they were handed: none may be posted. A
 * wait is named by its link, and several share one (questions asked on one issue open its page), so
 * one counts as named only where no wait still open shares its link: a post naming the open twin is
 * taken.
 */
async function settledNamed(room: RoomRow, firing: ReminderFiring, text: string): Promise<Wait[]> {
  const named = firing.waits.filter((w) => text.includes(w.link));
  if (named.length === 0) return [];
  const { namespace } = await roomAuth(room);
  // core's own re-read of the record it fired the reminder from, never fenced by the session's token
  const waits = await outsideTokenScope(() =>
    projectWaits(firing.projectId, firing.slug, namespace, new Date()),
  );
  const open = new Set(waits.map((w) => w.id));
  const openLinks = new Set(waits.map((w) => w.link));
  return named.filter((w) => !open.has(w.id) && !openLinks.has(w.link));
}

/** The morning's one result taken, or null where another already holds it. */
async function claim(room: RoomRow, check: string, finding: string | null) {
  return insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: check,
    kind: 'check_result',
    actorKind: 'session',
    input: { finding, reminder: true },
  });
}

const answered = (check: string) =>
  no<{ posted: string | null }>(
    'SUPPORT_CHECK_ANSWERED',
    '/check',
    `${check} already has its one result; a morning reminder is posted once, and nothing was posted`,
  );

/** Where a reminder's post went. */
interface Posted {
  messageId: string | null;
  conversationId: string | null;
  thread: string | null;
}

/** Give the morning's result back: its post did not go out, so the reminder can be answered again. */
async function release(claimed: { id: string }): Promise<void> {
  await db.delete(supportActions).where(eq(supportActions.id, claimed.id));
}

/**
 * Post the screened line where the firing's route says. Where it lands is resolved before the
 * morning's one result is claimed, and a post that fails gives the claim back, so a refusal or a
 * failure leaves the reminder to answer again (as `checks.ts:checkResult` does, ISS-933, ISS-1227).
 */
async function post(
  room: RoomRow,
  firing: ReminderFiring,
  check: string,
  screened: { text: string; proof: ProvenMessage },
): Promise<Outcome<{ posted: string | null }>> {
  let send: () => Promise<Outcome<Posted>>;
  if (firing.route === 'thread') {
    const thread = await projectThreadFor(room, firing.projectId);
    if (!thread.ok) {
      return no(
        'SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE',
        '/check',
        `${firing.slug}'s own thread of ${room.rid} could not be opened (${thread.why}); nothing was posted, try again`,
      );
    }
    send = async () => {
      const posted = await postInThread({ room, thread: thread.thread, ...screened });
      return { ok: true, value: { ...posted, thread: thread.thread } };
    };
  } else {
    const to = await destinationOf(room, '/check');
    if (!to.ok) return to;
    send = async () => {
      const posted = await postTo(room, to.value, screened.text);
      if (!posted.ok) return posted;
      const { messageId } = posted.value;
      return { ok: true, value: { messageId, conversationId: null, thread: null } };
    };
  }
  const claimed = await claim(room, check, screened.text);
  if (!claimed) return answered(check);
  let sent: Outcome<Posted>;
  try {
    sent = await send();
  } catch (err) {
    await release(claimed);
    throw err;
  }
  if (!sent.ok) {
    await release(claimed);
    return sent;
  }
  const at = sent.value;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: at.conversationId,
    thread: check,
    kind: 'check_posted',
    actorKind: 'core',
    input: { text: screened.text, reminder: firing.projectId },
    output: { route: firing.route, rid: room.rid, thread: at.thread },
    externalId: at.messageId,
  });
  return { ok: true, value: { posted: at.messageId } };
}

/**
 * The agent's one result for a morning reminder: its words posted in the project's technical
 * channel, screened, or null and nothing posted. Refused by name, nothing posted, where it links a
 * wait the record settled since the reminder was handed.
 */
export async function reminderResult(
  room: RoomRow,
  check: string,
  firing: ReminderFiring,
  finding: string | null,
): Promise<Outcome<{ posted: string | null }>> {
  if (finding === null) {
    return (await claim(room, check, null))
      ? { ok: true, value: { posted: null } }
      : answered(check);
  }
  const words = await scrubbedForRoom(room, finding);
  const name =
    (await projectName(firing.projectId)) ??
    (await findProjectSlugs([firing.projectId])).get(firing.projectId) ??
    firing.slug;
  // a direct message names the project first, as every line of the owner's direct message does
  const line = firing.route === 'dm' ? technicalLine(name, words) : words;
  const admitted = await screenForThread(room, null, check, line, 'operations-reply', TOOL);
  if (!admitted.ok) return admitted;
  const settled = await settledNamed(room, firing, admitted.value.text);
  if (settled.length > 0) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: null,
      thread: check,
      kind: 'refused',
      actorKind: 'session',
      tool: TOOL,
      input: { text: admitted.value.text },
      output: { code: 'SUPPORT_REMINDER_SETTLED', settled: settled.map((w) => w.id) },
    });
    return no(
      'SUPPORT_REMINDER_SETTLED',
      '/finding',
      `nothing was posted: the record settled ${settled.map((w) => JSON.stringify(w.ask)).join(', ')} since this reminder was handed, so it waits on nobody; leave it out and post the rest, or finding null when nothing is left`,
    );
  }
  return post(room, firing, check, admitted.value);
}
