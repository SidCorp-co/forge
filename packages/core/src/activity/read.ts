// What each project of a workspace works now and next (ISS-951, mockups MK-8 and MK-9), one row per
// project the caller can read: its master as `masters/read.ts:readMasterGlances` derives it, the issues
// in flight at the step `issue_work_state` records, its backlog in the master's own admissible order
// (`devices/admissible.ts:readAdmissibleForProjects`), the decisions it waits on the caller for
// (`development/needs-you-viewer.ts:readNeedsYouAcross`), its next release's progress and the issues
// landed and waiting for a release.
//
// The page reads this on every move of any project, so it is read per workspace, not per project:
// each leg is a fixed number of statements, and the release forecast, the one leg that costs seconds
// on a project with many requirements, is kept off the path (`release-glance.ts`).

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { WorkStep } from '@forge/contracts/issue-vocabulary';
import type { NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import {
  ORG_ACTIVITY_GROUPS,
  ORG_ACTIVITY_LIST_LIMIT,
  type OrgActivity,
  type OrgActivityDoing,
  type OrgActivityGroup,
  type OrgActivityMaster,
  type OrgActivityNow,
  type OrgActivityPerson,
  type OrgActivityProject,
  type OrgActivitySkipReason,
} from '@forge/contracts/org-activity';
import type { ActorAgency } from '@forge/contracts/permissions';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { readNeedsYouAcross } from '../development/index.js';
import { readAdmissibleForProjects, SESSION_SILENCE_TIMEOUT_S } from '../devices/index.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type MasterGlance, readMasterGlances } from '../masters/index.js';
import { glanceCache } from './glance-cache.js';
import { releaseGlances } from './release-glance.js';

/** How long a read waits for a project's leg it holds no answer for (`glance-cache.ts`). */
export const GLANCE_BUDGET_MS = 250;

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());
const uuids = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/** How long the decisions a project owes a reader are served before they are read again behind the page. */
const PEOPLE_FRESH_MS = 5_000;

/** How long a question's words run on its one line. */
const PERSON_LINE_MAX = 140;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OrgProject {
  id: string;
  slug: string;
  name: string;
}

/** The org's live projects the caller can read, under the request's token fence. */
async function readableProjects(orgId: string, userId: string): Promise<OrgProject[]> {
  const visible = new Set(await loadVisibleProjectIds(userId));
  const rows = rowsOf<OrgProject>(
    await db.execute(sql`
      SELECT id, slug, name FROM projects
       WHERE org_id = ${orgId} AND archived_at IS NULL
       ORDER BY name, id`),
  );
  return rows.filter((p) => visible.has(String(p.id)));
}

/** In progress at any step, or carried by a release at its release step. */
async function readInFlight(projectIds: readonly string[]): Promise<Map<string, OrgActivityNow[]>> {
  const out = new Map<string, OrgActivityNow[]>();
  if (projectIds.length === 0) return out;
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT i.id, i.project_id, i.iss_seq, p.issue_prefix, i.title, i.status,
             w.step, w.step_started_at
        FROM issues i
        JOIN projects p ON p.id = i.project_id
        LEFT JOIN issue_work_state w ON w.issue_id = i.id
       WHERE i.project_id IN (${uuids(projectIds)})
         AND i.archived_at IS NULL
         AND (i.status = 'in_progress' OR (i.status = 'awaiting_release' AND w.step = 'release'))
       ORDER BY w.step_started_at DESC NULLS LAST, i.iss_seq DESC`),
  );
  for (const r of rows) {
    const projectId = String(r.project_id);
    const list = out.get(projectId) ?? [];
    list.push({
      issueId: String(r.id),
      key: formatIssueRef(r.issue_prefix as string | null, Number(r.iss_seq)),
      title: String(r.title),
      status: r.status as IssueStatus,
      step: (r.step as WorkStep | null) ?? null,
      stepSince: iso(r.step_started_at),
    });
    out.set(projectId, list);
  }
  return out;
}

async function readAwaitingRelease(projectIds: readonly string[]): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const rows = rowsOf<{ project_id: string; n: number }>(
    await db.execute(sql`
      SELECT project_id, count(*)::int AS n FROM issues
       WHERE project_id IN (${uuids(projectIds)})
         AND status = 'awaiting_release' AND archived_at IS NULL
       GROUP BY project_id`),
  );
  return new Map(rows.map((r) => [String(r.project_id), Number(r.n)]));
}

/** The issue each question decision is asked on, by key: a question's decision carries only its own id. */
async function questionIssueKeys(questionIds: readonly string[]): Promise<Map<string, string>> {
  if (questionIds.length === 0) return new Map();
  const rows = rowsOf<{ id: string; issue_prefix: string | null; iss_seq: number }>(
    await db.execute(sql`
      SELECT q.id, p.issue_prefix, i.iss_seq
        FROM agent_questions q
        JOIN issues i ON i.id = q.issue_id
        JOIN projects p ON p.id = i.project_id
       WHERE q.id IN (${uuids(questionIds)})`),
  );
  return new Map(
    rows.map((r) => [String(r.id), formatIssueRef(r.issue_prefix, Number(r.iss_seq))]),
  );
}

const oneLine = (text: string): string => {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line.length > PERSON_LINE_MAX ? `${line.slice(0, PERSON_LINE_MAX - 1).trimEnd()}…` : line;
};

/**
 * A decision as a row names it: a question by its own words and the issue it hangs on, anything else
 * by its title and key. Never an id as text: a question asked on nothing names no key.
 */
function personOf(d: NeedsYouDecision, issueOfQuestion: Map<string, string>): OrgActivityPerson {
  if (d.entity === 'question') {
    return { group: d.group, key: issueOfQuestion.get(d.key) ?? null, title: oneLine(d.question) };
  }
  const title = d.group === 'answer' ? oneLine(d.question) : oneLine(d.title || d.question);
  return { group: d.group, key: UUID.test(d.key) ? null : d.key, title };
}

interface PeopleGlance {
  total: number;
  items: OrgActivityPerson[];
}

/**
 * The decisions one project owes one reader: the whole Needs you read of that project, which costs a
 * hundred statements and more, so it is kept off the page's path (`glance-cache.ts`).
 */
async function readPeople(key: string): Promise<PeopleGlance> {
  const [userId, agency, projectId] = key.split('|') as [string, ActorAgency, string];
  const [owes] = await readNeedsYouAcross(userId, agency, new Date(), [projectId]);
  const shown = (owes?.decisions ?? []).slice(0, ORG_ACTIVITY_LIST_LIMIT);
  const issueOfQuestion = await questionIssueKeys(
    shown.filter((d) => d.entity === 'question' && UUID.test(d.key)).map((d) => d.key),
  );
  return { total: owes?.total ?? 0, items: shown.map((d) => personOf(d, issueOfQuestion)) };
}

export const peopleGlances = glanceCache('the decisions owed', PEOPLE_FRESH_MS, readPeople);

const masterOf = (m: MasterGlance | undefined): OrgActivityMaster =>
  m
    ? {
        state: m.state,
        since: m.since,
        lastPassEndedAt: m.lastPass?.endedAt ?? null,
        lastBeatAt: m.lastBeatAt,
        silentAfterSeconds: SESSION_SILENCE_TIMEOUT_S,
        pane: m.pane,
        doing: doingOf(m),
        dialog: m.state === 'waiting_person' ? m.dialog : null,
      }
    : {
        state: 'none',
        since: null,
        lastPassEndedAt: null,
        lastBeatAt: null,
        silentAfterSeconds: SESSION_SILENCE_TIMEOUT_S,
        pane: null,
        doing: null,
        dialog: null,
      };

/** The open pass's verb and issue; else, while runs are out, the issue of the newest. */
function doingOf(m: MasterGlance): OrgActivityDoing | null {
  if (m.pass) return { kind: 'pass', verb: m.pass.verb, issueKey: m.pass.issueKey };
  if (m.newestRunIssue) return { kind: 'run', verb: null, issueKey: m.newestRunIssue };
  return null;
}

/**
 * Why the last pass took nothing while a backlog stood, from what core holds: a turn somebody began
 * at the pane, or a pane working by hand now; its box taking no new run; its runs out or slots full.
 * Null where it took something, where no backlog stands, or where core holds no reason.
 */
export function skipOf(m: MasterGlance | undefined, backlog: number): OrgActivitySkipReason | null {
  if (!m || backlog === 0 || !m.lastPass || m.lastPass.dispatched.length > 0) return null;
  if (m.state === 'busy' || m.lastPass.trigger === 'unprompted') return 'busy_by_hand';
  if (m.poolClosed) return 'pool_closed';
  if (m.runsOut > 0 || m.slotsFull) return 'one_at_a_time';
  return null;
}

const RUNNING = new Set(['in_pass', 'busy', 'runs_out']);

/** Where a row stands, by its master and what is owed, never by an in-progress issue (MK-9). */
export function groupOf(
  p: Pick<OrgActivityProject, 'master' | 'next' | 'people' | 'awaitingRelease'>,
): OrgActivityGroup {
  const state = p.master.state;
  if (RUNNING.has(state)) return 'running';
  if (state === 'waiting_person') return 'waiting';
  if (state !== 'none' && p.next.total > 0) return 'idle';
  if (p.people.total > 0 || p.awaitingRelease > 0 || p.next.total > 0) return 'waiting';
  return 'quiet';
}

export async function readOrgActivity(
  orgId: string,
  viewer: { userId: string; agency: ActorAgency },
  now: Date = new Date(),
  opts: { budgetMs?: number } = {},
): Promise<OrgActivity> {
  const projects = await readableProjects(orgId, viewer.userId);
  const ids = projects.map((p) => p.id);
  const budget = opts.budgetMs ?? GLANCE_BUDGET_MS;
  const peopleKey = (projectId: string) => `${viewer.userId}|${viewer.agency}|${projectId}`;
  const [inFlight, awaiting, admissible, people, masters, releases] = await Promise.all([
    readInFlight(ids),
    readAwaitingRelease(ids),
    readAdmissibleForProjects(ids, ORG_ACTIVITY_LIST_LIMIT),
    peopleGlances.read(ids.map(peopleKey), budget),
    readMasterGlances(ids, now),
    releaseGlances.read(ids, budget),
  ]);
  const rows = projects.map((p): OrgActivityProject => {
    const owes = people.values.get(peopleKey(p.id));
    const glance = masters.get(p.id);
    const backlog = admissible.totals.get(p.id) ?? 0;
    const release = releases.values.get(p.id);
    const base = {
      projectId: p.id,
      slug: p.slug,
      name: p.name,
      master: masterOf(glance),
      now: inFlight.get(p.id) ?? [],
      next: {
        total: backlog,
        items: admissible.items
          .filter((a) => a.projectId === p.id)
          .map((a) => ({
            issueId: a.issueId,
            key: a.issueKey ?? a.issueId,
            title: a.title ?? '',
            priority: a.priority,
          })),
        skip: skipOf(glance, backlog),
      },
      people: owes?.read ? owes.value : { total: 0, items: [] },
      peoplePending: !owes?.read,
      release: release?.read ? release.value : null,
      releasePending: !release?.read,
      awaitingRelease: awaiting.get(p.id) ?? 0,
    };
    return { ...base, group: groupOf(base) };
  });
  const order = (g: OrgActivityGroup) => ORG_ACTIVITY_GROUPS.indexOf(g);
  rows.sort((a, b) => order(a.group) - order(b.group) || a.name.localeCompare(b.name));
  const sum = (f: (r: OrgActivityProject) => number) => rows.reduce((n, r) => n + f(r), 0);
  return {
    generatedAt: now.toISOString(),
    orgId,
    projects: rows,
    refreshing: people.refreshing || releases.refreshing,
    totals: {
      projects: rows.length,
      running: rows.filter((r) => r.group === 'running').length,
      inFlight: sum((r) => r.now.length),
      queued: sum((r) => r.next.total),
      people: sum((r) => r.people.total),
      awaitingRelease: sum((r) => r.awaitingRelease),
      noMaster: rows.filter((r) => r.master.state === 'none').length,
    },
  };
}
