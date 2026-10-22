// Where the steward's one decision question lands (REQ-48 BC-5): on the issue or the requirement it
// is about, as any question on them is, or, for a feedback item, beside it under `about`, since an
// item's own question is its reporter's clarification and this one is a triager's or a member's to
// answer. Only the project's steward asks, naming a run of this project, and every option is
// one of Forge's fixed decisions, each carrying the run and the basis it read: the answer is carried
// out against that run (`decision-act.ts`), so no other asker can spell one.

import { randomUUID } from 'node:crypto';
import { isStewardDecisionQuestion, type StewardRefusalCode } from '@forge/contracts/steward';
import { refuser } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { askQuestion } from '../questions/index.js';
import { heldStewardOf } from './account.js';
import { decisionSubjectOf } from './decision-subject-of.js';
import { runOfProject } from './runs-store.js';

const refuse = refuser<StewardRefusalCode>('STEWARD_DECISION_SUBJECT_UNKNOWN');

/** The fingerprint every option of one decision question carries: the run that asked, and the basis it read. */
export const decisionFingerprint = (runId: string, basis: string) => `steward:${runId}:${basis}`;

/** The run and basis a decision question's fingerprint names, or null for one of another shape. */
export function fingerprintOf(
  fingerprint: string | undefined,
): { runId: string; basis: string } | null {
  const hit = /^steward:([0-9a-f-]{36}):(.+)$/.exec(fingerprint ?? '');
  return hit?.[1] && hit[2] ? { runId: hit[1], basis: hit[2] } : null;
}

export interface DecisionAsk {
  projectId: string;
  runId: string;
  userId: string;
  /** The item, by key: an issue key, REQ-n or FB-n. */
  about: string;
  prompt: string;
  options: { id: string; label: string }[];
  recommendedOptionId: string;
  /** The basis of the standing the run read. */
  basis: string;
}

/** Ask one decision question about `about`; the question's id and the item it stands on or names. */
export async function askStewardDecision(input: DecisionAsk) {
  await requireCan(actorFor(input.userId), 'project.read', projectResource(input.projectId));
  if (input.userId !== (await heldStewardOf(input.projectId))) {
    throw refuse(
      'STEWARD_DECISION_FORBIDDEN',
      "a steward decision is asked by the project's steward account alone.",
    );
  }
  // the answer logs its act against this run, so it is one of this project's
  if (!(await runOfProject(input.projectId, input.runId))) {
    throw refuse('STEWARD_RUN_UNKNOWN', `no steward run ${input.runId} in this project`);
  }
  if (!isStewardDecisionQuestion(input.options)) {
    throw refuse(
      'STEWARD_DECISION_OPTIONS_UNKNOWN',
      `every option is one of Forge's fixed decisions (steward.open, steward.keep, steward.drop, steward.link:REQ-n:BC-n, steward.requirement, steward.merge:<key>, steward.withdraw, steward.verify, steward.reopen); not: ${input.options.map((o) => o.id).join(', ')}`,
      '/options',
    );
  }
  const subject = await decisionSubjectOf(input.projectId, input.about.toUpperCase());
  const fingerprint = decisionFingerprint(input.runId, input.basis);
  const anchor =
    subject.kind === 'issue'
      ? { issueId: subject.id }
      : subject.kind === 'requirement'
        ? { requirementId: subject.id }
        : { about: { feedbackId: subject.id } };
  const asked = await askQuestion({
    id: randomUUID(),
    projectId: input.projectId,
    ...anchor,
    askedBy: input.userId,
    prompt: input.prompt,
    blockerKind: 'human',
    answer: {
      shape: 'choice',
      options: input.options.map((o) => ({
        id: o.id,
        label: o.label,
        authority: 'writer',
        bindsTo: 'this_call',
        executedBy: 'core',
        fingerprint,
      })),
      recommendedOptionId: input.recommendedOptionId,
    },
  });
  return { id: asked.id, subject };
}
