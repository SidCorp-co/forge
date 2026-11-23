// An operations room's writes (REQ-75 BC-21): each runs as the member whose message, handed to this
// turn, asked for it (`ops-asker.ts`), under that member's own permissions — the same `requireCan` and kernel guards
// their own click would meet, under the turn's token acting for them — and never under a permission
// of the bot's. One exception, a project admin's own delegation: a speaker with no Forge account whom
// the project declares by chat identity for an issue's reopen or status move (REQ-90 BC-15) has it
// moved at their request, by the declaration, with their message cited on the transition.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { currentPatScope, runWithPatScope } from '../credentials/pat-scope.js';
import { createFeedback } from '../feedback/index.js';
import { listIssues, transitionIssueStatus } from '../issues/index.js';
import { isRefusal } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { draftRequirement } from '../requirements/index.js';
import { actsWords, declarationAsk, declarationsOf, type RulingDeciderRead } from './deciders.js';
import { writerOfHandedMessage } from './delivery.js';
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
export async function asAsker<T>(
  asker: Asker,
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
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
export async function refusalsOf<T>(fn: () => Promise<OpsOutcome<T>>): Promise<OpsOutcome<T>> {
  try {
    return await fn();
  } catch (err) {
    if (isRefusal(err)) return { ok: false, refusals: [...err.refusals] };
    throw err;
  }
}

type MoveInput = Extract<OperationsActInput, { action: 'move' }>;

/** The writer of the message a move cites, as the project declares them for its moves (REQ-90 BC-15). */
interface DeclaredMover {
  who: string;
  key: string;
  declaration: RulingDeciderRead;
}

/**
 * Whether the unmapped writer of `input.message` has the move by the project's declaration of their
 * chat identity: the declaration covering an issue's reopen or status move on the issue's project,
 * said in that project's own room. Otherwise the refusal naming why: no declaration (with the one
 * yes or no the agent may ask, BC-16), one for other acts, or a word said in another project's room.
 * `unmapped` is passed on where the message names no writer this turn was handed.
 */
async function declaredMover(
  room: RoomRow,
  input: MoveInput,
  project: { id: string; slug: string },
  unmapped: OpsOutcome<never>,
): Promise<OpsOutcome<DeclaredMover>> {
  const writer = await writerOfHandedMessage(room.id, input.thread, input.message);
  if (!writer) return unmapped;
  const who = writer.label ? `@${writer.label}` : `account ${writer.key}`;
  const declared = await declarationsOf(project.id, writer.key);
  const declaration = declared.find(
    (d) => d.acts.includes('reopen') && (!d.targets || d.targets.includes(project.slug)),
  );
  if (!declaration) {
    const acts = [...new Set(declared.flatMap((d) => d.acts))];
    return no(
      declared.length > 0 ? 'SUPPORT_DECIDER_ACT_NOT_DECLARED' : 'SUPPORT_DECIDER_NOT_DECLARED',
      '/message',
      `${who} holds no Forge account and is ${declared.length > 0 ? `declared on ${project.slug} to decide ${actsWords(acts)} [knowledge:${declared[0]?.ruling}], not` : 'not declared to decide'} ${actsWords(['reopen'])}${declared.length > 0 ? '' : ` on ${project.slug}`}, so ${input.issue} is not moved at their word. ${await declarationAsk(project.id, who, ['reopen'])}. Nothing was moved`,
    );
  }
  if (room.projectId !== project.id) {
    return no(
      'SUPPORT_DECIDER_OUTSIDE_PROJECT_ROOM',
      '/message',
      `${who} is declared to move ${project.slug}'s issues in ${project.slug}'s own room, and ${input.message} was said in a room of another project: their word there moves nothing. Nothing was moved`,
    );
  }
  return { ok: true, value: { who, key: writer.key, declaration } };
}

export async function move(room: RoomRow, input: MoveInput): Promise<OpsOutcome<unknown>> {
  const project = await projectOfKey(room, input.issue, input.project);
  if (!project.ok) return project;
  const found = await askerOf(room, input.thread, input.message, 'project.write');
  const mover = found.ok
    ? null
    : found.refusals.some((r) => r.code === 'OPS_ASKER_UNMAPPED')
      ? await declaredMover(room, input, project.value, found)
      : found;
  if (mover && !mover.ok) return mover;
  const listed = await listIssues(
    project.value.id,
    { key: input.issue },
    { sort: 'updatedAt:desc', limit: 1, offset: 0 },
  );
  if (!listed.ok) return no('OPS_ISSUE_UNKNOWN', '/issue', listed.message);
  const issue = listed.rows[0];
  if (!issue) {
    return no('OPS_ISSUE_UNKNOWN', '/issue', `${project.value.slug} holds no issue ${input.issue}`);
  }
  if (mover?.ok) return moveAsDeclared(input, project.value, issue, mover.value);
  if (!found.ok) return found;
  const asker = found;
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

/**
 * The move a declared speaker asked for (REQ-90 BC-15): made by the room's own session under the
 * project admin's declaration, the kernel's guards on the edge applying as to anyone, and recorded
 * with their identity, the declaration and their message as its reason, so the issue says at whose
 * word it moved.
 */
async function moveAsDeclared(
  input: MoveInput,
  project: { id: string; slug: string },
  issue: { id: string; status: IssueStatus; reopenCount: number },
  mover: DeclaredMover,
): Promise<OpsOutcome<unknown>> {
  const turn = currentPatScope();
  if (!turn?.userId) throw new Error('support: a declared move ran with no session to make it');
  const sessionUserId = turn.userId;
  const why = `At ${mover.who}'s word (message ${input.message} in thread ${input.thread}), whom the project declares by chat identity to decide ${actsWords(['reopen'])} [knowledge:${mover.declaration.ruling}]: ${input.reason}`;
  return refusalsOf(async () => {
    const moved = await transitionIssueStatus(
      { id: issue.id, projectId: project.id, status: issue.status, reopenCount: issue.reopenCount },
      input.to,
      { type: 'user', id: sessionUserId, agency: 'agent' },
      { reason: why, transitionReason: why },
    );
    return {
      ok: true as const,
      value: {
        issue: input.issue,
        from: issue.status,
        to: moved.status,
        as: mover.who,
        declaredBy: `knowledge:${mover.declaration.ruling}`,
      },
    };
  });
}

export async function draftRequirementAct(
  room: RoomRow,
  input: Extract<OperationsActInput, { action: 'draft_requirement' }>,
): Promise<OpsOutcome<unknown>> {
  const project = await projectInScope(room, input.project);
  if (!project.ok) return project;
  const asker = await askerOf(room, input.thread, input.message, 'project.write');
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
  const asker = await askerOf(room, input.thread, input.message, 'project.write');
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
