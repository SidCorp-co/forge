// The BA notice of workflow requirement-to-delivery step `acceptance`: a requirement read delivered
// tells every holder of requirements.approve on its project that the check is theirs, once per
// delivered revision, and the accept of that revision resolves it.

import type { OutboxEventPayload as Payload } from '@forge/contracts/outbox-events';
import { userLabel } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { holdersOf } from '../permissions/index.js';
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

export function registerRequirementNotifications(): void {
  const name = 'notify-requirements';
  consume('requirement.delivered', { name, handle: delivered });
  consume('requirement.accepted', { name, handle: accepted });
}
