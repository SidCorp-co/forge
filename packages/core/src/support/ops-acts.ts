// An operations room's acts (REQ-75 BC-20..BC-24), behind the same check every support act passes
// (the caller is the room's own session, `access.ts`). Each is gated twice before anything runs: by
// the role's grant (`ops-role.ts`), and by the room's scope (`ops-scope.ts`). A read runs as the
// room. A write runs as the member who wrote last in the thread (`ops-asker.ts`), under that
// member's own permissions — the same `requireCan` and kernel guards their own click would meet,
// under the turn's token acting for them — and never under a permission of the bot's.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { Refusal } from '@forge/contracts/refusal';
import type { SupportRecordKind } from '@forge/contracts/support';
import type { OperationsAction } from '@forge/contracts/support-operations';
import { currentPatScope, runWithPatScope } from '../credentials/pat-scope.js';
import { projectHasLiveMaster, projectRunnerBuilds } from '../devices/index.js';
import { createFeedback } from '../feedback/index.js';
import { listIssues, transitionIssueStatus } from '../issues/index.js';
import { isRefusal } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { listReleases } from '../release-batch/index.js';
import { draftRequirement } from '../requirements/index.js';
import { type Asker, askerOf } from './ops-asker.js';
import { readPublicPage } from './ops-research.js';
import { grantRefusal, roleOfRoom } from './ops-role.js';
import { projectInScope, projectOfKey, projectsInScope, type ScopedProject } from './ops-scope.js';
import { no } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';

export type OpsOutcome<T> = { ok: true; value: T } | { ok: false; refusals: Refusal[] };

export type OperationsActInput =
  | { action: 'projects' }
  | {
      action: 'issues';
      project: string;
      status?: IssueStatus | undefined;
      key?: string | undefined;
    }
  | { action: 'releases'; project: string }
  | {
      action: 'move';
      thread: string;
      issue: string;
      project?: string | undefined;
      to: IssueStatus;
      reason?: string | undefined;
    }
  | { action: 'draft_requirement'; thread: string; project: string; title: string; summary: string }
  | {
      action: 'draft_feedback';
      thread: string;
      project: string;
      kind: SupportRecordKind;
      title: string;
      summary: string;
      requirement?: string | undefined;
      issue?: string | undefined;
      screen?: string | undefined;
    }
  | { action: 'research'; thread: string; url: string };

/** The Feedback kind each route a draft names is filed as. */
const FEEDBACK_KIND = { defect: 'bug', feature: 'idea', request: 'change_request' } as const;

/** The act, gated by the room's kind, its role's grant and its scope. */
export async function operationsAct(
  room: RoomRow,
  input: OperationsActInput,
): Promise<OpsOutcome<unknown>> {
  if (room.kind !== 'operations') {
    return no(
      'OPS_NOT_AN_OPERATIONS_ROOM',
      '/action',
      `${input.action} is an operations room's act, and this room is a support group`,
    );
  }
  const role = await roleOfRoom(room);
  if (!role.ok) return role;
  const lacking = grantRefusal(role.value, input.action);
  const out = lacking ?? (await act(room, input));
  if ('thread' in input) await recordOperation(room, input, out);
  return out;
}

async function act(room: RoomRow, input: OperationsActInput): Promise<OpsOutcome<unknown>> {
  switch (input.action) {
    case 'projects':
      return { ok: true, value: { projects: await projectsRead(room) } };
    case 'issues':
      return issuesRead(room, input);
    case 'releases':
      return releasesRead(room, input.project);
    case 'move':
      return move(room, input);
    case 'draft_requirement':
      return draftRequirementAct(room, input);
    case 'draft_feedback':
      return draftFeedbackAct(room, input);
    case 'research':
      return readPublicPage(input.url);
  }
}

/** Every project of the room's reach: its runners online, whether a master is resident. */
async function projectsRead(room: RoomRow) {
  const reach = await projectsInScope(room);
  return Promise.all(
    reach.map(async (p) => ({
      slug: p.slug,
      name: p.name,
      issuePrefix: p.issuePrefix,
      runnersOnline: (await projectRunnerBuilds(p.id)).map((r) => r.name),
      masterResident: await projectHasLiveMaster(p.id),
    })),
  );
}

async function issuesRead(
  room: RoomRow,
  input: { project: string; status?: IssueStatus | undefined; key?: string | undefined },
): Promise<OpsOutcome<unknown>> {
  const project = await projectInScope(room, input.project);
  if (!project.ok) return project;
  const listed = await listIssues(
    project.value.id,
    {
      ...(input.status ? { status: [input.status] } : {}),
      ...(input.key ? { key: input.key } : {}),
    },
    { sort: 'updatedAt:desc', limit: 30, offset: 0 },
  );
  if (!listed.ok) return no('OPS_ISSUE_UNKNOWN', `/${listed.field}`, listed.message);
  return {
    ok: true,
    value: {
      project: project.value.slug,
      total: listed.total,
      issues: listed.rows.map((r) => ({
        key: keyOf(project.value, r.issSeq),
        title: r.title,
        status: r.status,
        priority: r.priority,
      })),
    },
  };
}

async function releasesRead(room: RoomRow, slug: string): Promise<OpsOutcome<unknown>> {
  const project = await projectInScope(room, slug);
  if (!project.ok) return project;
  const list = await listReleases(project.value.id, null);
  return {
    ok: true,
    value: {
      project: project.value.slug,
      releases: list.releases.slice(0, 10).map((r) => ({
        version: r.version,
        state: r.state,
        current: r.current,
        name: r.name,
        issueCount: r.issueCount,
      })),
    },
  };
}

const keyOf = (project: ScopedProject, seq: number) => `${project.issuePrefix ?? 'ISS'}-${seq}`;

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

async function move(
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

async function draftRequirementAct(
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

async function draftFeedbackAct(
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

/** A write or a page read, recorded on the room as an `operation` (or `refused`) action. */
async function recordOperation(
  room: RoomRow,
  input: OperationsActInput & { thread: string },
  out: OpsOutcome<unknown>,
): Promise<void> {
  const { action, thread, ...args } = input;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread,
    kind: out.ok ? 'operation' : 'refused',
    actorKind: 'session',
    tool: action satisfies OperationsAction,
    input: args,
    output: out.ok ? out.value : { refusals: out.refusals },
  });
}
