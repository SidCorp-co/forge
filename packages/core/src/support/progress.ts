// Following what a support session recorded (REQ-75 BC-15): on every event that can move a Feedback
// item's phase — the work it was routed to being created or moving, a release shipping, a
// requirement moving — each open link of the project is read again, a phase that changed is posted
// in its thread, and a link stops once its item shipped, was confirmed or was declined. A link moves
// from the phase it was read at, so two deliveries never post one change twice.

import { externalItemPhases } from '../feedback/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { closesThread, phaseLine } from './rules.js';
import {
  advanceLink,
  insertAction,
  openLinksOfProject,
  projectsWithOpenLinks,
  roomById,
} from './store.js';
import { postInThread } from './thread.js';

/** Read every open link of a project again and post what moved. */
export async function followProjectItems(projectId: string): Promise<number> {
  const links = await openLinksOfProject(projectId);
  if (links.length === 0) return 0;
  const phases = await externalItemPhases(
    projectId,
    links.map((l) => l.feedbackId),
  );
  let posted = 0;
  for (const link of links) {
    const now = phases.get(link.feedbackId);
    if (!now || now.phase === link.lastPhase) continue;
    const closed = closesThread(now.phase);
    if (!(await advanceLink(link.feedbackId, link.lastPhase, now.phase, closed))) continue;
    const line = phaseLine(now.phase, now.key);
    const room = await roomById(link.roomId);
    if (!line || !room) continue;
    try {
      const sent = await postInThread({ room, thread: link.thread, text: line });
      await insertAction({
        roomId: room.id,
        projectId,
        conversationId: sent.conversationId,
        thread: link.thread,
        kind: 'progress_posted',
        actorKind: 'core',
        input: { from: link.lastPhase },
        output: { phase: now.phase, feedbackKey: now.key, closed },
        externalId: sent.messageId,
        feedbackId: link.feedbackId,
      });
      posted++;
    } catch (err) {
      logger.error(
        { err, feedbackId: link.feedbackId, roomId: room.id },
        'support: a progress line could not be posted',
      );
    }
  }
  return posted;
}

/**
 * Every followed item read again (a process timer): a triage or a decline moves an item's phase
 * with no event a consumer hears, so nothing waits on the next event to be told.
 */
export async function followAllItems(): Promise<void> {
  for (const projectId of await projectsWithOpenLinks()) {
    await followProjectItems(projectId).catch((err) =>
      logger.error({ err, projectId }, 'support: following recorded items failed'),
    );
  }
}

export function registerSupportProgress(): void {
  const name = 'support-progress';
  const handle = async (p: { projectId: string }) => {
    await followProjectItems(p.projectId);
  };
  consume('issue.created', { name, handle });
  consume('issue.transitioned', { name, handle });
  consume('release.shipped', { name, handle });
  consume('requirement.transitioned', { name, handle });
  consume('feedback.verifySettled', { name, handle });
}
