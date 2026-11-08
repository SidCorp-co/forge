// An operations room's reads (REQ-75 BC-20), and a channel agent's over the projects it follows
// (ISS-844, ISS-874): each runs as the room, over the projects its scope reaches (`ops-scope.ts`),
// and reads only what the room's members may already see there. A parked issue carries what it
// waits on and from whom (`ops-waiting.ts`, ISS-877). A release not yet shipped carries what holds
// it (`ops-release-holds.ts`, ISS-1009).

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { requirementKey } from '@forge/contracts/requirements';
import { recentIssueNotes } from '../comments/index.js';
import { projectHasLiveMaster, projectRunnerBuilds } from '../devices/index.js';
import { listIssues } from '../issues/index.js';
import { getIssueContexts } from '../pipeline/index.js';
import { holdsAnAct, listReleases } from '../release-batch/index.js';
import { listRowsOf } from '../requirements/index.js';
import { releaseHoldOf, UNSEEN } from './ops-release-holds.js';
import { projectInScope, projectsInScope, type ScopedProject } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { waitingOf } from './ops-waiting.js';
import { no } from './outcome.js';
import type { RoomRow } from './store.js';
import { scrubbedForRoom } from './thread.js';

/** How many of one issue's latest notes and step handoffs its read carries, and how much of each. */
const ISSUE_NOTES = 5;
const NOTE_CHARS = 1500;

const clipped = (text: string) =>
  text.length > NOTE_CHARS
    ? `${text.slice(0, NOTE_CHARS)}… (cut at ${NOTE_CHARS} characters)`
    : text;

/** What one step's handoff says, as a line: its summary where it wrote one, else its payload. */
function handoffText(payload: unknown): string {
  const p = payload as { summary?: unknown; notes?: unknown } | null;
  if (typeof p?.summary === 'string') return p.summary;
  if (typeof p?.notes === 'string') return p.notes;
  return JSON.stringify(payload);
}

/**
 * One issue's latest comments and step handoffs, newest first, bounded and scrubbed of the room's
 * secrets (ISS-999): what a channel agent reads before it tells a person how the issue is going.
 */
async function progressOf(room: RoomRow, projectId: string, issueId: string) {
  const [notes, handoffs] = await Promise.all([
    recentIssueNotes(issueId, ISSUE_NOTES),
    getIssueContexts({ projectId, issueId, kind: 'handoff', limit: ISSUE_NOTES, orderDir: 'desc' }),
  ]);
  return {
    notes: await Promise.all(
      notes.map(async (n) => ({
        at: n.at.toISOString(),
        text: clipped(await scrubbedForRoom(room, n.body)),
      })),
    ),
    handoffs: await Promise.all(
      handoffs.map(async (h) => ({
        step: h.step,
        at: h.createdAt.toISOString(),
        text: clipped(await scrubbedForRoom(room, handoffText(h.payload))),
      })),
    ),
  };
}

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
  // a parked issue says what it waits on and from whom, so the agent can tell a person what they
  // owe instead of sending them to look it up (ISS-877)
  const waits = await waitingOf(project.value.id, listed.rows);
  // one issue asked for by its key carries its latest notes and handoffs (ISS-999)
  const one = input.key && listed.rows.length === 1 ? listed.rows[0] : undefined;
  const progress = one ? await progressOf(room, project.value.id, one.id) : null;
  return {
    ok: true,
    value: {
      project: project.value.slug,
      total: listed.total,
      issues: listed.rows.map((r) => {
        const waiting = waits.get(r.id);
        return {
          key: keyOf(project.value, r.issSeq),
          title: r.title,
          status: r.status,
          priority: r.priority,
          ...(waiting ? { waiting } : {}),
          ...(progress && r.id === one?.id ? progress : {}),
        };
      }),
    },
  };
}

export async function releasesRead(room: RoomRow, slug: string): Promise<OpsOutcome<unknown>> {
  const project = await projectInScope(room, slug);
  if (!project.ok) return project;
  const list = await listReleases(project.value.id, null);
  const shown = list.releases.slice(0, 10);
  const releases = await Promise.all(
    shown.map(async (r) => ({
      version: r.version,
      state: r.state,
      current: r.current,
      name: r.name,
      issueCount: r.issueCount,
      // a release not yet shipped says what holds it, so a room is told whose act it waits on
      ...(holdsAnAct(r) ? { holds: await releaseHoldOf(project.value.id, r.version) } : {}),
    })),
  );
  return {
    ok: true,
    value: {
      project: project.value.slug,
      releases,
      ...(releases.some((r) => 'holds' in r) ? { unseen: UNSEEN } : {}),
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
