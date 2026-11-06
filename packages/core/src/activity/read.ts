// What each project of a workspace works now and next (ISS-951, mockups MK-8 and MK-9), one row per
// project the caller can read: its master as `masters/read.ts:readMasterGlances` derives it, the issues
// in flight at the step `issue_work_state` records, its backlog in the master's own admissible order
// (`devices/admissible.ts:readAdmissibleForProjects`), the decisions it waits on the caller for
// (`development/needs-you-viewer.ts:readNeedsYouAcross`), its next release's progress and the issues
// landed and waiting for a release.
//
// A person reads no record key here (ISS-951 round 4): every title and question is read through
// `record-keys.ts:withoutRecordKeys` with the projects' own issue prefixes, and what the master does
// names its issue by title. A row's group and the text beside it are both read from its master's one
// state (`group.ts`), and every project something waits on the reader for is grouped first.
//
// Each row's lane (ISS-979, `lane.ts`) is built here from what the row already read: its runs, its
// status moves as batches, its releases (`lane-releases.ts`) and the decisions owed the reader as pins.
//
// The page reads this on every move of any project, so it is read per workspace, not per project:
// each leg is a fixed number of statements, and the release forecast, the one leg that costs seconds
// on a project with many requirements, is kept off the path (`release-glance.ts`).

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { WorkStep } from '@forge/contracts/issue-vocabulary';
import type { NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import {
  ORG_ACTIVITY_GROUPS,
  ORG_ACTIVITY_LANE_MINUTES,
  ORG_ACTIVITY_LIST_LIMIT,
  ORG_ACTIVITY_WAIT_LIMIT,
  type OrgActivity,
  type OrgActivityGroup,
  type OrgActivityMaster,
  type OrgActivityNow,
  type OrgActivityPerson,
  type OrgActivityProject,
  type OrgActivitySource,
} from '@forge/contracts/org-activity';
import type { ActorAgency } from '@forge/contracts/permissions';
import { withoutRecordKeys } from '@forge/contracts/record-keys';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { readNeedsYouAcross } from '../development/index.js';
import { readAdmissibleForProjects, SESSION_SILENCE_TIMEOUT_S } from '../devices/index.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type MasterGlance, readMasterGlances } from '../masters/index.js';
import { readProjectEvents } from './events.js';
import { glanceCache } from './glance-cache.js';
import { doingOf, groupOf, pauseOf, skipOf, standingOf } from './group.js';
import { laneOf, lastActivityOf } from './lane.js';
import { readLaneReleases } from './lane-releases.js';
import { releaseGlances } from './release-glance.js';

/** How many of each source's events a lane reads per project over its two hours. */
const LANE_EVENTS_LIMIT = 200;

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());
const uuids = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * How long the decisions owed a reader are served before they are read again behind the page. Round 2
 * read them again every 5 s, and the page reads once more while anything is read behind it, so an
 * open page kept a Needs you read of every project running without end.
 */
const PEOPLE_FRESH_MS = 30_000;

/** How long a question's words run on its one line. */
const PERSON_LINE_MAX = 140;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OrgProject {
  id: string;
  slug: string;
  name: string;
  issue_prefix: string | null;
}

/** The projects' own issue prefixes, which a title is read without beside the shared ones. */
const prefixesOf = (projects: readonly { issue_prefix: string | null }[]): string[] =>
  projects.flatMap((p) => (p.issue_prefix ? [p.issue_prefix] : []));

/** The org's live projects the caller can read, under the request's token fence. */
async function readableProjects(orgId: string, userId: string): Promise<OrgProject[]> {
  const visible = new Set(await loadVisibleProjectIds(userId));
  const rows = rowsOf<OrgProject>(
    await db.execute(sql`
      SELECT id, slug, name, issue_prefix FROM projects
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
      title: withoutRecordKeys(String(r.title), prefixesOf([r as { issue_prefix: string | null }])),
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
 * A decision as a row names it: a question by its own words, anything else by its title, with no
 * record key in either; the key of the item it is asked on rides along for a tooltip. Never an id: a
 * question asked on nothing names no key.
 */
function personOf(
  d: NeedsYouDecision,
  issueOfQuestion: Map<string, string>,
  prefixes: readonly string[],
): OrgActivityPerson {
  const read = (text: string) => oneLine(withoutRecordKeys(text, prefixes));
  const shared = { decisionId: d.id, group: d.group, since: d.touchedAt, opens: d.opens };
  if (d.entity === 'question') {
    return { ...shared, key: issueOfQuestion.get(d.key) ?? null, title: read(d.question) };
  }
  const title = d.group === 'answer' ? read(d.question) : read(d.title || d.question);
  return { ...shared, key: UUID.test(d.key) ? null : d.key, title };
}

interface PeopleGlance {
  total: number;
  items: OrgActivityPerson[];
}

/** The key the decisions owed one reader across one workspace's projects are held under. */
const peopleKeyOf = (userId: string, agency: ActorAgency, projectIds: readonly string[]) =>
  `${userId}|${agency}|${projectIds.join(',')}`;

/**
 * The decisions a workspace's projects owe one reader: one Needs you read across all of them
 * (`readNeedsYouAcross`, which reads its projects two at a time and primes what they share once), kept
 * off the page's path (`glance-cache.ts`). Round 2 held one key per project, so a workspace started
 * thirteen of those reads at once, each with its own limiter, past the pool's ten connections.
 */
async function readPeople(key: string): Promise<Map<string, PeopleGlance>> {
  const [userId, agency, ids] = key.split('|') as [string, ActorAgency, string];
  const projectIds = ids ? ids.split(',') : [];
  const out = new Map<string, PeopleGlance>(projectIds.map((id) => [id, { total: 0, items: [] }]));
  if (projectIds.length === 0) return out;
  const owed = await readNeedsYouAcross(
    userId,
    agency,
    new Date(),
    projectIds,
    ORG_ACTIVITY_WAIT_LIMIT,
  );
  const projects = rowsOf<{ id: string; slug: string; issue_prefix: string | null }>(
    await db.execute(
      sql`SELECT id, slug, issue_prefix FROM projects WHERE id IN (${uuids(projectIds)})`,
    ),
  );
  const idOf = new Map(projects.map((r) => [r.slug, String(r.id)]));
  const prefixes = prefixesOf(projects);
  const shown = owed.map((o) => ({
    projectId: idOf.get(o.projectSlug),
    total: o.total,
    decisions: o.decisions.slice(0, ORG_ACTIVITY_WAIT_LIMIT),
  }));
  const issueOfQuestion = await questionIssueKeys(
    shown.flatMap((s) =>
      s.decisions.filter((d) => d.entity === 'question' && UUID.test(d.key)).map((d) => d.key),
    ),
  );
  for (const s of shown) {
    if (!s.projectId) continue;
    out.set(s.projectId, {
      total: s.total,
      items: s.decisions.map((d) => personOf(d, issueOfQuestion, prefixes)),
    });
  }
  return out;
}

export const peopleGlances = glanceCache('the decisions owed', PEOPLE_FRESH_MS, readPeople, {
  concurrency: 1,
});

/** The projects a people key reads (`peopleKeyOf`). */
const projectsOfPeopleKey = (key: string): string[] => {
  const ids = key.split('|')[2];
  return ids ? ids.split(',') : [];
};

/** The moves that can change a project's next release or the run releasing it. */
const RELEASE_MOVES: ReadonlySet<OrgActivitySource> = new Set(['release', 'run', 'status']);

/**
 * One of a workspace's projects moved (ISS-1053): every held people glance that reads it is stale,
 * and its release glance too where the move can change a release. `ws/broadcast-subscribers.ts:tellOrg`
 * calls this for every move it frames, so the page's next read starts their refresh and answers
 * `refreshing`, and a person's settled decision leaves "waiting on you" within one refresh rather than
 * when the 30 s glance next ages out. Answers how many glances it marked.
 */
export function projectMoved(projectId: string, source: OrgActivitySource): number {
  const people = peopleGlances.stale((key) => projectsOfPeopleKey(key).includes(projectId));
  const release = RELEASE_MOVES.has(source) ? releaseGlances.stale((key) => key === projectId) : 0;
  return people + release;
}

const KEY_SHAPE = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,9})$/;

/**
 * The title of each issue a master's open pass or newest run names, by `projectId|key`, read without
 * record keys: one statement however many projects, sent even where none names one, so the read's
 * statements do not depend on what its masters do. A key in neither the shared nor the project's own
 * prefix, or one no issue of the project answers, has no title.
 */
async function readDoingTitles(
  projects: readonly OrgProject[],
  masters: ReadonlyMap<string, MasterGlance>,
): Promise<Map<string, string>> {
  const asked: { projectId: string; key: string; seq: number }[] = [];
  for (const p of projects) {
    const m = masters.get(p.id);
    for (const key of new Set([m?.pass?.issueKey, m?.newestRunIssue])) {
      const shape = key ? KEY_SHAPE.exec(key) : null;
      const prefix = shape?.[1]?.toUpperCase();
      if (!key || !shape || (prefix !== 'ISS' && prefix !== p.issue_prefix)) continue;
      asked.push({ projectId: p.id, key, seq: Number(shape[2]) });
    }
  }
  const pairs = asked.length
    ? sql`(i.project_id, i.iss_seq) IN (${sql.join(
        asked.map((a) => sql`(${a.projectId}::uuid, ${a.seq}::int)`),
        sql`, `,
      )})`
    : sql`false`;
  const rows = rowsOf<{ project_id: string; iss_seq: number; title: string }>(
    await db.execute(sql`SELECT i.project_id, i.iss_seq, i.title FROM issues i WHERE ${pairs}`),
  );
  const prefixes = prefixesOf(projects);
  const out = new Map<string, string>();
  for (const a of asked) {
    const row = rows.find(
      (r) => String(r.project_id) === a.projectId && Number(r.iss_seq) === a.seq,
    );
    if (row) out.set(`${a.projectId}|${a.key}`, withoutRecordKeys(String(row.title), prefixes));
  }
  return out;
}

const masterOf = (
  m: MasterGlance | undefined,
  titleOf: (key: string) => string | null,
): OrgActivityMaster =>
  m
    ? {
        state: m.state,
        since: m.since,
        lastPassEndedAt: m.lastPass?.endedAt ?? null,
        lastBeatAt: m.lastBeatAt,
        silentAfterSeconds: SESSION_SILENCE_TIMEOUT_S,
        pane: m.pane,
        doing: doingOf(m, titleOf),
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

/** What each leg of one workspace read took, in milliseconds, in the order they are named. */
export type OrgActivityLegs = Map<OrgActivityLeg, number>;
export const ORG_ACTIVITY_LEGS = [
  'projects',
  'inflight',
  'awaiting',
  'backlog',
  'people',
  'masters',
  'releases',
  'lanes',
  'shipped',
] as const;
export type OrgActivityLeg = (typeof ORG_ACTIVITY_LEGS)[number];

/** `a;dur=1.2, b;dur=3.4`: each leg's milliseconds for a `Server-Timing` header, and nothing of its data. */
export const legsTiming = (legs: OrgActivityLegs): string =>
  ORG_ACTIVITY_LEGS.filter((l) => legs.has(l))
    .map((l) => `${l};dur=${(legs.get(l) ?? 0).toFixed(1)}`)
    .join(', ');

export async function readOrgActivity(
  orgId: string,
  viewer: { userId: string; agency: ActorAgency },
  now: Date = new Date(),
  opts: {
    /** How long to wait for what is kept off the path where it was never read; the page waits none. */
    waitMs?: number;
    /** Filled with what each leg took. */
    legs?: OrgActivityLegs;
  } = {},
): Promise<OrgActivity> {
  const legs = opts.legs ?? new Map();
  const timed = async <T>(leg: OrgActivityLeg, read: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await read();
    } finally {
      legs.set(leg, performance.now() - started);
    }
  };
  const projects = await timed('projects', () => readableProjects(orgId, viewer.userId));
  const ids = projects.map((p) => p.id);
  const waitMs = opts.waitMs ?? 0;
  const peopleKey = peopleKeyOf(viewer.userId, viewer.agency, ids);
  const laneFrom = new Date(now.getTime() - ORG_ACTIVITY_LANE_MINUTES * 60_000);
  const [inFlight, awaiting, admissible, people, masters, releases, events, shipped] =
    await Promise.all([
      timed('inflight', () => readInFlight(ids)),
      timed('awaiting', () => readAwaitingRelease(ids)),
      timed('backlog', () => readAdmissibleForProjects(ids, ORG_ACTIVITY_LIST_LIMIT)),
      timed('people', () => peopleGlances.read([peopleKey], waitMs)),
      timed('masters', async () => {
        const glances = await readMasterGlances(ids, now);
        return { glances, titles: await readDoingTitles(projects, glances) };
      }),
      timed('releases', () => releaseGlances.read(ids, waitMs)),
      timed('lanes', () => readProjectEvents(ids, { since: laneFrom, limit: LANE_EVENTS_LIMIT })),
      timed('shipped', () => readLaneReleases(ids, laneFrom, now)),
    ]);
  const owed = people.values.get(peopleKey);
  const rows = projects.map((p): OrgActivityProject => {
    const glance = masters.glances.get(p.id);
    const backlog = admissible.totals.get(p.id) ?? 0;
    const release = releases.values.get(p.id);
    const owedHere = owed?.read
      ? (owed.value.get(p.id) ?? { total: 0, items: [] })
      : { total: 0, items: [] };
    const master = masterOf(glance, (key) => masters.titles.get(`${p.id}|${key}`) ?? null);
    const projectEvents = events.get(p.id) ?? [];
    const standing = standingOf(glance);
    return {
      projectId: p.id,
      slug: p.slug,
      name: p.name,
      group: groupOf(standing, owedHere.total),
      standing,
      pause: pauseOf(glance),
      master,
      now: inFlight.get(p.id) ?? [],
      next: {
        total: backlog,
        items: admissible.items
          .filter((a) => a.projectId === p.id)
          .map((a) => ({
            issueId: a.issueId,
            key: a.issueKey ?? a.issueId,
            title: withoutRecordKeys(a.title ?? '', prefixesOf([p])),
            priority: a.priority,
          })),
        skip: skipOf(glance, backlog),
      },
      people: owedHere,
      peoplePending: !owed?.read,
      release: release?.read ? release.value : null,
      releasePending: !release?.read,
      awaitingRelease: awaiting.get(p.id) ?? 0,
      lane: laneOf(projectEvents, laneFrom, now, shipped.get(p.id) ?? [], owedHere),
      lastActivityAt: lastActivityOf(projectEvents, master.lastPassEndedAt),
    };
  });
  const order = (g: OrgActivityGroup) => ORG_ACTIVITY_GROUPS.indexOf(g);
  rows.sort((a, b) => order(a.group) - order(b.group) || a.name.localeCompare(b.name));
  return {
    generatedAt: now.toISOString(),
    orgId,
    projects: rows,
    refreshing: people.refreshing || releases.refreshing,
    totals: {
      projects: rows.length,
      ...(Object.fromEntries(
        ORG_ACTIVITY_GROUPS.map((g) => [g, rows.filter((r) => r.group === g).length]),
      ) as Record<OrgActivityGroup, number>),
    },
  };
}
