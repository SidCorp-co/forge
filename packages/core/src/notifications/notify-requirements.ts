// The BA notice of workflow requirement-to-delivery step `acceptance`: a requirement read delivered
// tells every holder of requirements.approve on its project that the check is theirs, once per
// delivered revision, and the accept of that revision resolves it.
//
// The author's notice of each step change (REQ-34 BC-21, Requirement lifecycle r15): a stored move,
// a linked issue's move and a delivery each read the requirement's step again
// (`requirements/step-notice.ts`). A step changed since its author was last told sends them one
// notice, naming the step and the one after it.

import type { OutboxEventPayload as Payload } from '@forge/contracts/outbox-events';
import { REQUIREMENT_STATE_LABELS } from '@forge/contracts/requirements';
import { userLabel } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { holdersOf } from '../permissions/index.js';
import { requirementOfIssue, type StepChange, stepChangeOf } from '../requirements/index.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

const checkKey = (requirementId: string, revision: number) =>
  `requirement-check:${requirementId}@r${revision}`;

async function delivered(p: Payload<'requirement.delivered'>): Promise<void> {
  const recipients =
    (await holdersOf('requirements.approve', [p.projectId])).get(p.projectId) ?? [];
  if (recipients.length === 0) {
    logger.warn(
      { requirement: p.key, project: p.projectId },
      'requirements: a delivered requirement has nobody holding requirements.approve to accept it',
    );
    return;
  }
  await emitNotification({
    recipients,
    projectId: p.projectId,
    type: 'requirement_delivered',
    title: `${p.key} r${p.revision} is delivered: ${p.title}`,
    body: 'Every live linked issue shipped and every business criterion is proven. Check the criteria against the traceability matrix, then accept the delivery or file feedback against it.',
    resolutionKey: checkKey(p.requirementId, p.revision),
    dedupeKey: `requirement-delivered:${p.requirementId}@r${p.revision}`,
  });
}

async function accepted(p: Payload<'requirement.accepted'>): Promise<void> {
  const who = (await userLabel(p.acceptedBy)) ?? p.acceptedBy;
  await resolveNotifications(
    checkKey(p.requirementId, p.revision),
    `${p.key} r${p.revision} accepted by ${who}`,
  );
}

/** Tells the author of `requirementId` the step it moved to, where it moved since they were last told. */
export async function tellStep(requirementId: string, cause: string): Promise<void> {
  await stepChangeOf(requirementId, (change) => tellAuthor(change, cause));
}

async function tellAuthor(change: StepChange, cause: string): Promise<void> {
  if (!change.authorId) {
    logger.info(
      { requirement: change.key, from: change.from, to: change.to },
      'requirements: an agent wrote this requirement, so no person is told of its step change',
    );
    return;
  }
  const to = REQUIREMENT_STATE_LABELS[change.to];
  await emitNotification({
    userId: change.authorId,
    projectId: change.projectId,
    type: 'requirement_step',
    title: `${change.key} is ${to}: ${change.title}`,
    body: change.next ? `Next: ${REQUIREMENT_STATE_LABELS[change.next]}.` : null,
    dedupeKey: `requirement-step:${change.requirementId}:${change.from}>${change.to}:${cause}`,
  });
}

export function registerRequirementNotifications(): void {
  const name = 'notify-requirements';
  consume('requirement.delivered', {
    name,
    handle: async (p) => {
      await delivered(p);
      await tellStep(p.requirementId, `delivered@r${p.revision}`);
    },
  });
  consume('requirement.accepted', { name, handle: accepted });
  consume('requirement.transitioned', {
    name,
    handle: (p) => tellStep(p.id, p.at),
  });
  consume('issue.transitioned', {
    name: 'notify-requirement-step',
    handle: async (p) => {
      // a linked issue leaving open starts a delivery, and its close can finish one
      const requirement = await requirementOfIssue(p.id);
      if (requirement) await tellStep(requirement.requirementId, `issue:${p.id}@${p.at}`);
    },
  });
}
