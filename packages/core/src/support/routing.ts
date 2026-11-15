// A room agent's routing decision for a message it was handed (ISS-1243): which project the message
// concerns, what the choice rested on, how sure the agent is, and whether it answers, gathers more,
// asks one short question or stays silent, and why. It is kept on the room as one `routing_decided`
// action of the turn that made it, so the turn record reads it and turns are counted by it; a turn
// that ends with none reads "no decision recorded", never a silence. A silence decided here is the
// message's stated silence too (`staySilent`), so the message is settled and never handed again.

import type { SupportDecideRequest } from '@forge/contracts/support';
import { namedProject } from './ops-scope.js';
import { knownThread, type Outcome, threadUnknown } from './outcome.js';
import { staySilent } from './service.js';
import { insertAction, type RoomRow } from './store.js';
import { scrubbedForRoom } from './thread.js';

/** What a decision answers: the project it names, by slug, and the silence it stated where it chose one. */
export interface RoutingDecided {
  decided: SupportDecideRequest['decision'];
  project: string | null;
  silent?: true;
}

/**
 * Record the session's routing decision for a message of the thread. The project it names must be
 * one the room reaches (its home, or one its binding follows): any other is refused by name and
 * nothing is recorded. Omitted, it names none: a message about no project (chatter, thanks).
 */
export async function decideRouting(
  room: RoomRow,
  input: SupportDecideRequest,
): Promise<Outcome<RoutingDecided>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  let project: string | null = null;
  if (input.project !== undefined) {
    const named = await namedProject(room, input.project);
    if (!named.ok) return named;
    project = named.value.slug;
  }
  const why = await scrubbedForRoom(room, input.why);
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'routing_decided',
    actorKind: 'session',
    input: {
      decision: input.decision,
      project,
      signals: [...new Set(input.signals)],
      confidence: input.confidence,
      why,
      ...(input.message ? { message: input.message } : {}),
    },
  });
  if (input.decision !== 'silent') {
    return { ok: true, value: { decided: input.decision, project } };
  }
  const silent = await staySilent(room, {
    thread: input.thread,
    message: input.message,
    reason: input.why,
  });
  if (!silent.ok) return silent;
  return { ok: true, value: { decided: 'silent', project, silent: true } };
}
