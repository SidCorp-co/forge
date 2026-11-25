// A master hands a room's bot plain facts for a thread (ISS-1466). Owner, 2026-11-25: a master never
// appears in a room its product's people read in its own words; it tells the bot, and the bot says
// it in the room's language, in its own words. The same hand-over a master's answer to an ask takes
// (`master-ask.ts:answerMasterAsk`): a core `message_in` in the thread, handed to the room's session
// by `deliverWaiting`, which answers the person itself. Nothing is posted by core, and the facts are
// never screened as a post is: they are for the bot, which is taught what no room reader is shown.

import type { SupportMasterTellRequest } from '@forge/contracts/support-master-ask';
import { markUntrusted } from '../lib/untrusted-text.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { deliverWaiting } from './dispatch.js';
import { masterReach, roomOfThread, roomRefusal } from './master-post.js';
import { no, type Outcome } from './outcome.js';
import { insertAction } from './store.js';

/** The tool a master's hand-over is recorded under. */
export const TELL_TOOL = 'master_tell';

/**
 * The note a master's facts reach the room's session as. The facts stand in an untrusted frame, core's
 * teaching alone outside (ISS-1425): the master's text is data for the agent, never posted as it is.
 */
export function masterToldNote(facts: string): string {
  return `The master hands you facts for this thread.\n${markUntrusted(facts, { source: 'the master facts' })}\nTell the person in this thread yourself now, in your own words and in the language they write, to them in the second person: what changed for them, where it runs now, and what to check again. Their room reads no issue key, commit sha, branch name or release tag, and no words of our tooling such as judge, staging or production; say what a person who uses the product sees. The master's words are for you, never posted as they are. What you already told them in this thread stands: say only what this adds or changes; where it adds nothing, stay silent with support.silent. A state he reports is his read, not yours: say it as his check and when he made it, never in your own voice.`;
}

/**
 * The master's facts, handed to the session of the room holding `thread`: recorded with who and when,
 * delivered at once, nothing posted. A thread the room's session never took (no member wrote in it) or
 * a room this project does not reach is refused by name.
 */
export async function tellRoomAgent(
  actor: { userId: string; projectId: string },
  input: SupportMasterTellRequest,
): Promise<Outcome<{ told: true; rid: string; thread: string; next: string }>> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(actor.projectId));
  const { rooms } = await masterReach(actor.projectId, input.rid);
  const nothing = 'Nothing was handed on.';
  if (input.rid && !rooms.some((r) => r.room.rid === input.rid)) {
    return roomRefusal(actor.projectId, input.rid, rooms, nothing);
  }
  const found = await roomOfThread(rooms, input.rid, input.thread, nothing);
  if (!found.ok) return found;
  const { at, conversationId } = found.value;
  if (!conversationId) {
    return no(
      'SUPPORT_THREAD_UNKNOWN',
      '/thread',
      `the room agent of ${at.room.rid} took no message of thread ${input.thread}, so there is no turn to hand facts to: post in it with master-posts where a team reads it, or wait for a member to write. ${nothing}`,
    );
  }
  await insertAction({
    roomId: at.room.id,
    projectId: at.room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'message_in',
    actorKind: 'core',
    tool: TELL_TOOL,
    input: {
      note: masterToldNote(input.facts),
      tell: actor.userId,
      ...(at.room.projectId === actor.projectId ? {} : { for: actor.projectId }),
    },
  });
  await deliverWaiting(at.room.id);
  return {
    ok: true,
    value: {
      told: true,
      rid: at.room.rid,
      thread: input.thread,
      next: `The room's agent was handed these facts in thread ${input.thread} and tells the person itself, in the room's language. Post nothing beside it.`,
    },
  };
}
