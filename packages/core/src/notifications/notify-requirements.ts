// The BA notice of workflow requirement-to-delivery step `acceptance`: a requirement moved to delivered
// tells every holder of requirements.approve on its project that the check is theirs, once per
// delivered revision, and the accept of that revision resolves it. Where the accept is the master's
// (`who-owes` `requirement.accept`), the Steward accepts by rule (`steward/requirement-rule-moves.ts`),
// so no person is asked and no task is opened only to be resolved in the same minute (ISS-1192).
//
// The author's notice of each step change (REQ-34 BC-21, Requirement lifecycle r15): each stored move
// reads the requirement's step again (`requirements/step-notice.ts`); a step changed since its author
// was last told sends them one notice, naming the step and the one after it. Only an act moves a
// step (REQ-74 BC-8), so a linked issue's move tells nothing. A step is activity: its record is
// `log` tier and rings no bell (ISS-1192, `notify-only-to-act`).

import type { OutboxEventPayload as Payload } from '@forge/contracts/outbox-events';
import { CHECK_SLA_WORKING_DAYS, REQUIREMENT_STATE_LABELS } from '@forge/contracts/requirements';
import { whoOwes } from '@forge/contracts/who-owes';
import { userLabel } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { holdersOf } from '../permissions/index.js';
import { readOwedPolicy } from '../project-config/index.js';
import { type StepChange, stepChangeOf } from '../requirements/index.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

const checkKey = (requirementId: string, revision: number) =>
  `requirement-check:${requirementId}@r${revision}`;

async function delivered(p: Payload<'requirement.delivered'>): Promise<void> {
  if (whoOwes('requirement.accept', await readOwedPolicy(p.projectId)).by === 'master') {
    logger.info(
      { requirement: p.key, revision: p.revision, project: p.projectId },
      'requirements: the accept is the master’s, so the Steward checks this delivery and no person is asked',
    );
    return;
  }
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
    requirementId: p.requirementId,
    title: `${p.key} r${p.revision} is delivered: ${p.title}`,
    // owed from the delivery on; the SLA is its latest day, never a day to wait for (ISS-1113)
    body: `It was marked delivered: every live business criterion passes on the running build. Check the criteria against the traceability matrix now, at the latest ${CHECK_SLA_WORKING_DAYS} working days after its last evidence, then accept the delivery or file feedback against it.`,
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
    requirementId: change.requirementId,
    title: `${change.key} is ${to}: ${change.title}`,
    body: change.next ? `Next: ${REQUIREMENT_STATE_LABELS[change.next]}.` : null,
    dedupeKey: `requirement-step:${change.requirementId}:${change.from}>${change.to}:${cause}`,
  });
}

export function registerRequirementNotifications(): void {
  const name = 'notify-requirements';
  // an agree, an accept and a delivery report their own move (REQ-12 BC-18): each tells its step
  consume('requirement.delivered', {
    name,
    handle: async (p) => {
      await delivered(p);
      await tellStep(p.requirementId, p.at);
    },
  });
  consume('requirement.accepted', {
    name,
    handle: async (p) => {
      await accepted(p);
      await tellStep(p.requirementId, p.at);
    },
  });
  consume('requirement.agreed', { name, handle: (p) => tellStep(p.requirementId, p.at) });
  consume('requirement.transitioned', {
    name,
    handle: (p) => tellStep(p.id, p.at),
  });
}
