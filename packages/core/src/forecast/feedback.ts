/**
 * Each feedback item's line, as the person who sent it means "done": untriaged, who triages it
 * (no date); routed to issues, when the last of them is in people's hands; routed to a new
 * requirement, when that requirement's issues are; a duplicate, its root's. The phase and whom it
 * waits on are the feedback list's own (`feedback/list-read.ts`), read as the viewer reads them.
 */

import { FEEDBACK_UNTRIAGED_PHASES, type FeedbackSummary } from '@forge/contracts/feedback';
import type {
  DeliveryForecast,
  FeedbackForecast,
  FeedbackForecasts,
  FeedbackShippedOwes,
} from '@forge/contracts/forecast';
import type { ActorAgency } from '@forge/contracts/permissions';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { rowsPerProject } from '../db/read-memo.js';
import { listFeedbackAs } from '../feedback/index.js';
import { type IssueRow, issueRowsOfFeedback } from './facts.js';
import { waitOn } from './model.js';
import { pausedOf, stamp } from './read.js';
import type { ForecastViewer } from './release.js';
import { type Reads, readsFor, scopeOf, stuckWaitOf } from './scope.js';

export interface LinkRow {
  id: string;
  routed_requirement_id: string | null;
  routed_requirement_seq: number | null;
  duplicate_of: string | null;
  issue_ids: string[] | null;
}

async function linksOf(projectId: string): Promise<Map<string, LinkRow>> {
  // every project's asks before the quiet point are one read (ISS-1070 r6)
  const rows = await rowsPerProject(
    'forecastFeedbackLinks',
    projectId,
    async (ids) =>
      rowsOf<LinkRow & { project_id: string }>(
        await db.execute(sql`
          SELECT f.id, f.project_id, f.routed_requirement_id, q.req_seq AS routed_requirement_seq,
                 f.duplicate_of, array_remove(array_agg(fri.issue_id::text), NULL) AS issue_ids
            FROM feedback f
            LEFT JOIN feedback_route_issues fri ON fri.feedback_id = f.id
            LEFT JOIN requirements q ON q.id = f.routed_requirement_id
           WHERE f.project_id IN (${idList(ids)})
           GROUP BY f.id, q.req_seq`),
      ),
    (r) => r.project_id,
  );
  return new Map(rows.map(({ project_id: _p, ...r }) => [r.id, r]));
}

// a snoozed item is parked out of New until its date, so no triage is owed it yet
const untriaged = (s: FeedbackSummary) =>
  (FEEDBACK_UNTRIAGED_PHASES as readonly string[]).includes(s.phase) && !s.snoozed;

/** Every listed item, its route links and its line, read from one simulation. */
export interface FeedbackLines {
  asOf: string;
  items: FeedbackSummary[];
  links: Map<string, LinkRow>;
  /** Each item's line by its id. */
  lines: Map<string, FeedbackForecast>;
}

export async function readFeedbackForecasts(
  viewer: { userId: string; agency: ActorAgency },
  projectId: string,
  forecastViewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<FeedbackForecasts> {
  const read = await readFeedbackLines(viewer, projectId, forecastViewer, now);
  return {
    ...stamp(read.asOf),
    projectId,
    items: read.items.flatMap((s) => {
      const f = read.lines.get(s.id);
      return f ? [f] : [];
    }),
  };
}

export async function readFeedbackLines(
  viewer: { userId: string; agency: ActorAgency },
  projectId: string,
  forecastViewer: ForecastViewer | null,
  now: Date = new Date(),
  /**
   * Items a door names, read whole beside the list: the list holds only the newest window
   * (`list-page-read.ts:LIST_WINDOW`), and an older item one door asks for is read past it (REQ-47 BC-3).
   */
  named: readonly string[] = [],
): Promise<FeedbackLines> {
  // the links, the issues they route to and the simulation need no item of the list: each starts
  // beside it, so the lines wait on the slower of the two, not on both in turn (ISS-1070 r18)
  const routed = routedOf(projectId);
  const [listed, reads] = await Promise.all([
    listFeedbackAs(viewer, projectId),
    readsFor(
      projectId,
      now,
      routed.then((r) => r.rows),
      forecastViewer,
    ),
  ]);
  if (!listed.ok) {
    throw new Error(
      `forecast: the feedback list refused an unfiltered read: ${listed.refusals[0]?.detail}`,
    );
  }
  const held = new Set(listed.list.feedback.map((s) => s.id));
  const past = named.filter((id) => !held.has(id));
  if (past.length === 0) return linesOf(listed.list.feedback, await routed, reads);
  const older = await listFeedbackAs(viewer, projectId, { ids: past });
  if (!older.ok) {
    throw new Error(
      `forecast: the feedback list refused the named items: ${older.refusals[0]?.detail}`,
    );
  }
  return linesOf([...listed.list.feedback, ...older.list.feedback], await routed, reads);
}

/** Each of `items`' line, for a door that read the items itself (`feedback/index.ts:listFeedbackIn`). */
export async function readFeedbackForecastsOver(
  items: readonly FeedbackSummary[],
  projectId: string,
  forecastViewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<FeedbackForecasts> {
  const read = await feedbackLinesOver(items, projectId, forecastViewer, now);
  return {
    ...stamp(read.asOf),
    projectId,
    items: read.items.flatMap((s) => {
      const f = read.lines.get(s.id);
      return f ? [f] : [];
    }),
  };
}

/**
 * A declined item carries no work, whatever route it kept (`feedback/service.ts:declineIn` keeps it):
 * it is never forecast, late or at risk (REQ-48 BC-9). A verified one keeps its shipped line, which
 * is never late.
 */
export const noWorkLine = (s: Pick<FeedbackSummary, 'key' | 'phase'>): FeedbackForecast | null =>
  s.phase === 'declined' ? { key: s.key, triage: null, delivery: null, owes: null } : null;

/**
 * What an item whose work shipped still owes (ISS-1103): its phase is the feedback list's
 * (`feedback/standing.ts:phaseOf`), resolved only once its requirement is delivered or its issues are
 * closed, so a shipped line beside any other phase waits on the verdicts that deliver it. FB-512 on
 * forge-dev read "Shipped 0.4.0-dev.532" beside "Planned" while REQ-86 waited on its judgement.
 */
export const owedAfterShip = (
  phase: FeedbackSummary['phase'],
  delivery: DeliveryForecast | null,
): FeedbackShippedOwes | null =>
  delivery?.shipped && phase !== 'resolved' && phase !== 'verified' ? 'judgement' : null;

/** The project's feedback links, and the issues every route among them names, read in one wave. */
interface Routed {
  links: Map<string, LinkRow>;
  /** Each routed issue by id. */
  byId: Map<string, IssueRow>;
  /** Each routed requirement's issues, by requirement id. */
  byReq: Map<string, IssueRow[]>;
  rows: IssueRow[];
}

async function routedOf(projectId: string): Promise<Routed> {
  const [links, routed] = await Promise.all([linksOf(projectId), issueRowsOfFeedback(projectId)]);
  const rows = routed
    .filter((r) => r.project_id === projectId)
    .map(({ project_id: _p, ...r }) => r)
    .sort((a, b) => a.iss_seq - b.iss_seq);
  const byReq = new Map<string, IssueRow[]>();
  for (const r of rows)
    if (r.requirement_id) byReq.set(r.requirement_id, [...(byReq.get(r.requirement_id) ?? []), r]);
  return { links, byId: new Map(rows.map((r) => [r.id, r])), byReq, rows };
}

/** The issues `items`' routes name: what a door that read a few items asks what shipped of. */
function rowsOfItems(items: readonly FeedbackSummary[], routed: Routed): IssueRow[] {
  const ids = new Set<string>();
  for (const s of items) {
    const link = routed.links.get(s.id);
    if (s.route?.route === 'issue') for (const id of link?.issue_ids ?? []) ids.add(id);
    else if (s.route?.route === 'new_requirement' && link?.routed_requirement_id)
      for (const r of routed.byReq.get(link.routed_requirement_id) ?? []) ids.add(r.id);
  }
  return routed.rows.filter((r) => ids.has(r.id));
}

async function feedbackLinesOver(
  listedItems: readonly FeedbackSummary[],
  projectId: string,
  forecastViewer: ForecastViewer | null,
  now: Date,
): Promise<FeedbackLines> {
  const routed = routedOf(projectId);
  const reads = await readsFor(
    projectId,
    now,
    routed.then((r) => rowsOfItems(listedItems, r)),
    forecastViewer,
  );
  return linesOf(listedItems, await routed, reads);
}

function linesOf(
  listedItems: readonly FeedbackSummary[],
  routed: Routed,
  reads: Reads,
): FeedbackLines {
  const items = [...listedItems];
  const { links, byId, byReq } = routed;
  const own = new Map<string, FeedbackForecast>();
  const pending: FeedbackSummary[] = [];
  for (const s of items) {
    const none = noWorkLine(s);
    if (none) {
      own.set(s.id, none);
      continue;
    }
    const link = links.get(s.id);
    if (untriaged(s)) {
      const w = s.waitingOn;
      own.set(s.id, {
        key: s.key,
        triage: pausedOf(
          reads.f.run.asOf,
          waitOn({ who: w.says.who, act: w.says.act, reason: w.says.rule }, null, s.updatedAt),
        ),
        delivery: null,
        owes: null,
      });
      continue;
    }
    let rows: IssueRow[] | null = null;
    let scopeKey = s.key;
    if (s.route?.route === 'issue') {
      rows = (link?.issue_ids ?? []).flatMap((id) => byId.get(id) ?? []);
    } else if (s.route?.route === 'new_requirement' && link?.routed_requirement_id) {
      rows = byReq.get(link.routed_requirement_id) ?? [];
      scopeKey = `REQ-${link.routed_requirement_seq}`;
    } else if (s.route?.route === 'duplicate') {
      pending.push(s);
      continue;
    }
    // a stuck item waits on what its standing names, never on a landing date the simulation guesses
    const stuck = stuckWaitOf({ stuck: s.times.stuck, waitingOn: s.waitingOn });
    const scope = rows ? scopeOf(reads, rows, 'requirement', scopeKey, null, stuck) : null;
    const delivery = scope?.delivery ?? null;
    own.set(s.id, { key: s.key, triage: null, delivery, owes: owedAfterShip(s.phase, delivery) });
  }
  for (const s of pending) {
    const root = links.get(s.id)?.duplicate_of;
    const of = root ? own.get(root) : undefined;
    const delivery = of?.delivery ?? null;
    own.set(s.id, {
      key: s.key,
      triage: of?.triage ?? null,
      delivery,
      owes: owedAfterShip(s.phase, delivery),
    });
  }
  return { asOf: reads.f.run.asOf, items, links, lines: own };
}

/**
 * Each requirement the project's feedback became, by its REQ key, with its issues in number order:
 * the rows the lines read (`routedOf`), so a reader beside them sends nothing of its own.
 */
export async function routedRequirementRows(projectId: string): Promise<Map<string, IssueRow[]>> {
  const { links, byReq } = await routedOf(projectId);
  const out = new Map<string, IssueRow[]>();
  for (const l of links.values())
    if (l.routed_requirement_id && l.routed_requirement_seq !== null)
      out.set(`REQ-${l.routed_requirement_seq}`, byReq.get(l.routed_requirement_id) ?? []);
  return out;
}
