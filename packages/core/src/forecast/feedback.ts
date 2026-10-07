/**
 * Each feedback item's line, as the person who sent it means "done": untriaged, who triages it
 * (no date); routed to issues, when the last of them is in people's hands; routed to a new
 * requirement, when that requirement's issues are; a duplicate, its root's. The phase and whom it
 * waits on are the feedback list's own (`feedback/list-read.ts`), read as the viewer reads them.
 */

import { FEEDBACK_UNTRIAGED_PHASES, type FeedbackSummary } from '@forge/contracts/feedback';
import type { FeedbackForecast, FeedbackForecasts } from '@forge/contracts/forecast';
import type { ActorAgency } from '@forge/contracts/permissions';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { listFeedbackAs } from '../feedback/index.js';
import { type IssueRow, issueRowsByIds, issueRowsOfRequirements } from './facts.js';
import { pausedOf, stamp } from './read.js';
import type { ForecastViewer } from './release.js';
import { readsFor, scopeOf } from './scope.js';

interface LinkRow {
  id: string;
  routed_requirement_id: string | null;
  routed_requirement_seq: number | null;
  duplicate_of: string | null;
  issue_ids: string[] | null;
}

async function linksOf(projectId: string): Promise<Map<string, LinkRow>> {
  const rows = rowsOf<LinkRow>(
    await db.execute(sql`
      SELECT f.id, f.routed_requirement_id, q.req_seq AS routed_requirement_seq, f.duplicate_of,
             array_remove(array_agg(fri.issue_id::text), NULL) AS issue_ids
        FROM feedback f
        LEFT JOIN feedback_route_issues fri ON fri.feedback_id = f.id
        LEFT JOIN requirements q ON q.id = f.routed_requirement_id
       WHERE f.project_id = ${projectId}
       GROUP BY f.id, q.req_seq`),
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// a snoozed item is parked out of New until its date, so no triage is owed it yet
const untriaged = (s: FeedbackSummary) =>
  (FEEDBACK_UNTRIAGED_PHASES as readonly string[]).includes(s.phase) && !s.snoozed;

export async function readFeedbackForecasts(
  viewer: { userId: string; agency: ActorAgency },
  projectId: string,
  forecastViewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<FeedbackForecasts> {
  const listed = await listFeedbackAs(viewer, projectId);
  if (!listed.ok) {
    throw new Error(
      `forecast: the feedback list refused an unfiltered read: ${listed.refusals[0]?.detail}`,
    );
  }
  const items = listed.list.feedback;
  const links = await linksOf(projectId);
  const carrierIds = [
    ...new Set(
      items.flatMap((s) => (s.route?.route === 'issue' ? (links.get(s.id)?.issue_ids ?? []) : [])),
    ),
  ];
  const reqIds = [
    ...new Set(
      items.flatMap((s) => {
        const id =
          s.route?.route === 'new_requirement' ? links.get(s.id)?.routed_requirement_id : null;
        return id ? [id] : [];
      }),
    ),
  ];
  const [carriers, byReq] = await Promise.all([
    issueRowsByIds(projectId, carrierIds),
    issueRowsOfRequirements(projectId, reqIds),
  ]);
  const byId = new Map(carriers.map((r) => [r.id, r]));
  const reads = await readsFor(
    projectId,
    now,
    [...carriers, ...[...byReq.values()].flat()],
    forecastViewer,
  );

  const own = new Map<string, FeedbackForecast>();
  const pending: FeedbackSummary[] = [];
  for (const s of items) {
    const link = links.get(s.id);
    if (untriaged(s)) {
      const w = s.waitingOn;
      own.set(s.id, {
        key: s.key,
        triage: pausedOf(reads.f.run.asOf, {
          who: w.who,
          act: w.act,
          reason: w.rule,
          ref: null,
          since: s.updatedAt,
        }),
        delivery: null,
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
    const scope = rows ? scopeOf(reads, rows, 'requirement', scopeKey, null) : null;
    own.set(s.id, { key: s.key, triage: null, delivery: scope?.delivery ?? null });
  }
  for (const s of pending) {
    const root = links.get(s.id)?.duplicate_of;
    const of = root ? own.get(root) : undefined;
    own.set(s.id, { key: s.key, triage: of?.triage ?? null, delivery: of?.delivery ?? null });
  }
  return {
    ...stamp(reads.f.run.asOf),
    projectId,
    items: items.flatMap((s) => {
      const f = own.get(s.id);
      return f ? [f] : [];
    }),
  };
}
