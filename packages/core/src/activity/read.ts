// What each project of a workspace works now and next (ISS-951, mockup MK-8), one row per project the
// caller can read: its master's standing (`masters/read.ts:readMasterStanding`), the issues in flight at
// the step `issue_work_state` records, the next issues in the master's own admissible order
// (`devices/admissible.ts:readAdmissibleForProjects`), the decisions it waits on the caller for
// (`development/needs-you-viewer.ts:readNeedsYouAcross`), its next release's progress
// (`forecast/scope.ts:readComingNext`) and the issues landed and waiting for a release.

import {
  ORG_ACTIVITY_GROUPS,
  ORG_ACTIVITY_LIST_LIMIT,
  type OrgActivity,
  type OrgActivityGroup,
  type OrgActivityMaster,
  type OrgActivityNow,
  type OrgActivityProject,
  type OrgActivityRelease,
} from '@forge/contracts/org-activity';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { WorkStep } from '@forge/contracts/issue-vocabulary';
import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { MasterStanding } from '@forge/contracts/master-standing';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { readNeedsYouAcross } from '../development/index.js';
import { readAdmissibleForProjects } from '../devices/index.js';
import { readComingNext } from '../forecast/index.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { createLimiter } from '../lib/bounded-concurrency.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { readMasterStanding } from '../masters/index.js';

/** Projects whose master and forecast are read at once: each read sends several statements of its own. */
const PROJECTS_AT_ONCE = 2;

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());

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
       WHERE i.project_id IN (${sql.join(
         projectIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
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
       WHERE project_id IN (${sql.join(
         projectIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
         AND status = 'awaiting_release' AND archived_at IS NULL
       GROUP BY project_id`),
  );
  return new Map(rows.map((r) => [String(r.project_id), Number(r.n)]));
}

/** The soonest requirement still landing, or the draft release where it carries anything. */
async function readNextRelease(projectId: string): Promise<OrgActivityRelease | null> {
  const coming = await readComingNext(projectId, null);
  const scope = coming.requirements[0] ?? (coming.draft.progress.total > 0 ? coming.draft : null);
  if (!scope) return null;
  return {
    key: scope.key,
    title: scope.title,
    shipped: scope.progress.shipped,
    awaitingRelease: scope.progress.awaitingRelease,
    total: scope.progress.total,
  };
}

const masterOf = (m: MasterStanding): OrgActivityMaster => ({
  state: m.state,
  since: m.since,
  lastPassEndedAt: m.lastPass?.endedAt ?? null,
  lastBeatAt: m.lastBeatAt,
});

/** Where a row stands; the order `ORG_ACTIVITY_GROUPS` declares is the page's. */
export function groupOf(
  p: Pick<OrgActivityProject, 'master' | 'now' | 'next' | 'people' | 'awaitingRelease'>,
): OrgActivityGroup {
  const state = p.master.state;
  if (state === 'in_pass' || state === 'runs_out' || p.now.length > 0) return 'working';
  if (state === 'waiting_person') return 'waiting';
  if (state !== 'none' && p.next.total > 0) return 'idle';
  if (p.people.total > 0 || p.awaitingRelease > 0 || p.next.total > 0) return 'waiting';
  return 'quiet';
}

export async function readOrgActivity(
  orgId: string,
  viewer: { userId: string; agency: ActorAgency },
  now: Date = new Date(),
): Promise<OrgActivity> {
  const projects = await readableProjects(orgId, viewer.userId);
  const ids = projects.map((p) => p.id);
  const limiter = createLimiter(PROJECTS_AT_ONCE);
  const [inFlight, awaiting, admissible, people, perProject] = await Promise.all([
    readInFlight(ids),
    readAwaitingRelease(ids),
    readAdmissibleForProjects(ids, ORG_ACTIVITY_LIST_LIMIT),
    readNeedsYouAcross(viewer.userId, viewer.agency, now, ids),
    Promise.all(
      projects.map((p) =>
        limiter.run(async () => ({
          master: await readMasterStanding(p.id),
          release: await readNextRelease(p.id),
        })),
      ),
    ),
  ]);
  const peopleBySlug = new Map(people.map((n) => [n.projectSlug, n]));
  const rows = projects.map((p, i): OrgActivityProject => {
    const held = perProject[i];
    if (!held) throw new Error(`org activity: project ${p.id} was read without its master`);
    const owes = peopleBySlug.get(p.slug);
    const base = {
      projectId: p.id,
      slug: p.slug,
      name: p.name,
      master: masterOf(held.master),
      now: inFlight.get(p.id) ?? [],
      next: {
        total: admissible.totals.get(p.id) ?? 0,
        items: admissible.items
          .filter((a) => a.projectId === p.id)
          .map((a) => ({
            issueId: a.issueId,
            key: a.issueKey ?? a.issueId,
            title: a.title ?? '',
            priority: a.priority,
          })),
      },
      people: {
        total: owes?.total ?? 0,
        items: (owes?.decisions ?? [])
          .slice(0, ORG_ACTIVITY_LIST_LIMIT)
          .map((d) => ({ group: d.group, key: d.key, title: d.title })),
      },
      release: held.release,
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
    totals: {
      projects: rows.length,
      inFlight: sum((r) => r.now.length),
      queued: sum((r) => r.next.total),
      people: sum((r) => r.people.total),
      awaitingRelease: sum((r) => r.awaitingRelease),
      noMaster: rows.filter((r) => r.master.state === 'none').length,
    },
  };
}
