// An operations room's reads (REQ-75 BC-20), and a channel agent's over its own project (ISS-844):
// each runs as the room, over the projects its scope reaches (`ops-scope.ts`), and reads only what
// the room's members may already see there.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { requirementKey } from '@forge/contracts/requirements';
import { projectHasLiveMaster, projectRunnerBuilds } from '../devices/index.js';
import { listIssues } from '../issues/index.js';
import { listReleases } from '../release-batch/index.js';
import { listRowsOf } from '../requirements/index.js';
import { projectInScope, projectsInScope, type ScopedProject } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { no } from './outcome.js';
import type { RoomRow } from './store.js';

/** Every project of the room's reach: its runners online, whether a master is resident. */
export async function projectsRead(room: RoomRow) {
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

export async function issuesRead(
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

export async function releasesRead(room: RoomRow, slug: string): Promise<OpsOutcome<unknown>> {
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

/** The project's requirements, newest first: key, title and status, as the Requirements list reads them. */
export async function requirementsRead(room: RoomRow, slug: string): Promise<OpsOutcome<unknown>> {
  const project = await projectInScope(room, slug);
  if (!project.ok) return project;
  const { rows } = await listRowsOf(project.value.id);
  return {
    ok: true,
    value: {
      project: project.value.slug,
      total: rows.length,
      requirements: rows.slice(0, 30).map((r) => ({
        key: requirementKey(r.reqSeq),
        title: r.title,
        status: r.status,
      })),
    },
  };
}

export const keyOf = (project: ScopedProject, seq: number) =>
  `${project.issuePrefix ?? 'ISS'}-${seq}`;
