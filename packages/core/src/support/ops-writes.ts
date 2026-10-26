// An operations room's writes (REQ-75 BC-21): each runs as the member who wrote last in the thread
// (`ops-asker.ts`), under that member's own permissions — the same `requireCan` and kernel guards
// their own click would meet, under the turn's token acting for them — and never under a permission
// of the bot's.

import { currentPatScope, runWithPatScope } from '../credentials/pat-scope.js';
import { createFeedback } from '../feedback/index.js';
import { listIssues, transitionIssueStatus } from '../issues/index.js';
import { isRefusal } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { draftRequirement } from '../requirements/index.js';
import { type Asker, askerOf } from './ops-asker.js';
import { projectInScope, projectOfKey } from './ops-scope.js';
import type { OperationsActInput, OpsOutcome } from './ops-types.js';
import { no } from './outcome.js';
import type { RoomRow } from './store.js';

/** The Feedback kind each route a draft names is filed as. */
const FEEDBACK_KIND = { defect: 'bug', feature: 'idea', request: 'change_request' } as const;

/**
 * Run `fn` as the asker: their permissions decide, the turn's token is the credential it arrived on
 * and it acts for them, fenced to the one project the act names.
 */
async function asAsker<T>(asker: Asker, projectId: string, fn: () => Promise<T>): Promise<T> {
  const turn = currentPatScope();
  if (!turn) throw new Error('support: an operations act ran with no token to act for its asker');
  return runWithPatScope(
    {
      projectIds: [projectId],
      tokenId: turn.tokenId,
      userId: asker.userId,
      agency: 'agent',
      onBehalfOf: asker.userId,
      grant: ['*'],
      scopes: ['read', 'write'],
    },
    fn,
  );
}

/** A write's outcome: its value, or the refusals the service or the kernel threw, passed on whole. */
async function refusalsOf<T>(fn: () => Promise<OpsOutcome<T>>): Promise<OpsOutcome<T>> {
  try {
    return await fn();
  } catch (err) {
    if (isRefusal(err)) return { ok: false, refusals: [...err.refusals] };
    throw err;
  }
}

export async function move(
  room: RoomRow,
  input: Extract<OperationsActInput, { action: 'move' }>,
): Promise<OpsOutcome<unknown>> {
  const project = await projectOfKey(room, input.issue, input.project);
  if (!project.ok) return project;
  const asker = await askerOf(room, input.thread);
  if (!asker.ok) return asker;
  const listed = await listIssues(
    project.value.id,
    { key: input.issue },
    { sort: 'updatedAt:desc', limit: 1, offset: 0 },
  );
  const issue = listed.ok ? listed.rows[0] : undefined;
  if (!issue) {
    return no('OPS_ISSUE_UNKNOWN', '/issue', `${project.value.slug} holds no issue ${input.issue}`);
  }
  return refusalsOf(() =>
    asAsker(asker.value, project.value.id, async () => {
      const actor = actorFor(asker.value.userId);
      // the gate the issue's own move door asks first, then the kernel's guards on the edge
      await requireCan(
        actor,
        'project.write',
        projectResource(project.value.id),
        'moving an issue',
      );
      const moved = await transitionIssueStatus(
        {
          id: issue.id,
          projectId: project.value.id,
          status: issue.status,
          reopenCount: issue.reopenCount,
        },
        input.to,
        { type: 'user', id: asker.value.userId, agency: 'agent' },
        { reason: input.reason, transitionReason: input.reason },
      );
      return {
        ok: true as const,
        value: {
          issue: input.issue,
          from: issue.status,
          to: moved.status,
          as: asker.value.label ?? asker.value.key,
        },
      };
    }),
  );
}

export async function draftRequirementAct(
  room: RoomRow,
  input: Extract<OperationsActInput, { action: 'draft_requirement' }>,
): Promise<OpsOutcome<unknown>> {
  const project = await projectInScope(room, input.project);
  if (!project.ok) return project;
  const asker = await askerOf(room, input.thread);
  if (!asker.ok) return asker;
  return refusalsOf(() =>
    asAsker(asker.value, project.value.id, async () => {
      const drafted = await draftRequirement({
        projectId: project.value.id,
        actor: { userId: asker.value.userId, agency: 'agent' },
        title: input.title,
        write: { reason: input.summary, criteria: [] },
        designs: [],
      });
      if (!drafted.ok) return { ok: false as const, refusals: drafted.refusals };
      return {
        ok: true as const,
        value: {
          requirement: drafted.requirement.key,
          status: 'draft',
          decidedBy: 'a person: a draft is a proposal, never a decision',
        },
      };
    }),
  );
}

export async function draftFeedbackAct(
  room: RoomRow,
  input: Extract<OperationsActInput, { action: 'draft_feedback' }>,
): Promise<OpsOutcome<unknown>> {
  const project = await projectInScope(room, input.project);
  if (!project.ok) return project;
  const asker = await askerOf(room, input.thread);
  if (!asker.ok) return asker;
  return refusalsOf(() =>
    asAsker(asker.value, project.value.id, async () => {
      const filed = await createFeedback({
        projectId: project.value.id,
        actor: { userId: asker.value.userId, agency: 'agent' },
        request: {
          kind: FEEDBACK_KIND[input.kind],
          title: input.title,
          body: input.summary,
          ...(input.requirement ? { requirement: input.requirement } : {}),
          ...(input.issue ? { issue: input.issue } : {}),
          ...(input.screen ? { screen: input.screen } : {}),
        },
      });
      if (!filed.ok) return { ok: false as const, refusals: filed.refusals };
      return {
        ok: true as const,
        value: { feedback: filed.feedback.key, phase: filed.feedback.phase },
      };
    }),
  );
}
