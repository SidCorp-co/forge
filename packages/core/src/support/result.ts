// What a support session recorded comes back as its result, never as progress (REQ-75 r6 BC-15): on
// every event that can move a Feedback item's phase, each open link of the project is read again;
// one that reached a final phase — live (resolved), confirmed (verified) or declined — closes, and
// the session is handed one note in the item's thread to post its result there, in the asker's
// words. Nothing is posted for triaged, planned or reopened. A link closes from the phase it was read
// at, so two deliveries never tell one result twice. The note says what settled the item (ISS-1032):
// an answer is told as answered, with the answer, never as live; a decline carries its reason.

import { externalItemResults } from '../feedback/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { deliverWaiting } from './dispatch.js';
import { tellProjectPromises } from './promise-watch.js';
import { resultNote } from './rules.js';
import {
  advanceLink,
  insertAction,
  openLinksOfProject,
  projectsWithOpenLinks,
  roomById,
  threadConversation,
} from './store.js';

/** Read every open link of a project again; hand the session each result that is final. */
export async function tellProjectResults(projectId: string): Promise<number> {
  const links = await openLinksOfProject(projectId);
  if (links.length === 0) return 0;
  const results = await externalItemResults(
    projectId,
    links.map((l) => l.feedbackId),
  );
  let told = 0;
  for (const link of links) {
    const now = results.get(link.feedbackId);
    if (!now) continue;
    const note = resultNote(now);
    if (!note) continue;
    if (!(await advanceLink(link.feedbackId, link.lastPhase, now.phase, true))) continue;
    const room = await roomById(link.roomId);
    if (!room) continue;
    const conversationId = await threadConversation(room.id, link.thread);
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: link.thread,
      kind: 'message_in',
      actorKind: 'core',
      input: { note },
      externalId: `result:${link.feedbackId}`,
      feedbackId: link.feedbackId,
    });
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: link.thread,
      kind: 'result_told',
      actorKind: 'core',
      input: { from: link.lastPhase },
      output: { phase: now.phase, feedbackKey: now.key, route: now.route },
      feedbackId: link.feedbackId,
    });
    told++;
    await deliverWaiting(room.id).catch((err) =>
      logger.error({ err, roomId: room.id }, 'support: a result note waits for the next turn'),
    );
  }
  return told;
}

/**
 * Every followed item read again (a process timer): a triage or a decline moves an item's phase
 * with no event a consumer hears, so nothing waits on the next event to be told.
 */
export async function tellAllResults(): Promise<void> {
  for (const projectId of await projectsWithOpenLinks()) {
    await tellProjectResults(projectId).catch((err) =>
      logger.error({ err, projectId }, 'support: telling recorded items results failed'),
    );
  }
}

export function registerSupportResults(): void {
  const name = 'support-results';
  // the same events answer a room's promises about the project's issues (ISS-1012): a landing, a
  // drop and a release each move one
  const handle = async (p: { projectId: string }) => {
    await tellProjectResults(p.projectId);
    await tellProjectPromises(p.projectId);
  };
  consume('issue.created', { name, handle });
  consume('issue.transitioned', { name, handle });
  consume('release.shipped', { name, handle });
  consume('requirement.transitioned', { name, handle });
  consume('feedback.verifySettled', { name, handle });
}
