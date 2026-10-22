// The one-off that retires the stale-draft sweep's questions (REQ-48 BC-5): that sweep asked merge,
// drop or keep on a draft untouched for a week, on a path beside the steward's, and its answer is
// carried out by nothing now. Each such question still open is voided, naming why, and its item is
// diagnosed again where it still reads stuck, so the steward asks with its own options; an answered
// keep is left as it was, which the steward still reads before asking. Gated by its
// `backfill_markers` row; a question it could not void is reported and leaves the marker unset.

import { sql } from 'drizzle-orm';
import { backfillMarkedIn, markBackfillIn } from '../db/backfill-markers.js';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { emitEvent } from '../outbox/index.js';
import { voidQuestionAs } from '../questions/index.js';
import { stewardAccountOf } from './account.js';
import { openStandings } from './ports.js';

export const STALE_DRAFT_RETIRE_KEY = 'stale-draft-questions-retired';

const VOID_REASON =
  "Forge no longer asks merge, drop or keep on a draft untouched for a week. The steward asks a stuck draft's decision with its own options, and answering this one would carry out nothing (REQ-48 BC-5).";

/** The option every stale-draft question offered, as its jsonb mark. */
const ASKED_MARK = JSON.stringify([{ id: 'stale_draft.drop' }]);

export interface RetireReport {
  voided: number;
  rediagnosed: number;
  refusals: { questionId: string; reason: string }[];
}

interface OpenRow {
  id: string;
  project_id: string;
  issue_id: string | null;
  requirement_id: string | null;
}

export async function retireStaleDraftQuestionsOnce(): Promise<RetireReport | null> {
  if (await db.transaction((tx) => backfillMarkedIn(tx, STALE_DRAFT_RETIRE_KEY))) return null;
  const report: RetireReport = { voided: 0, rediagnosed: 0, refusals: [] };
  const open = rowsOf<OpenRow>(
    await db.execute(sql`
      SELECT q.id, q.project_id, q.issue_id, q.requirement_id
        FROM agent_questions q
       WHERE q.status = 'open'
         AND q.steps -> 0 -> 'options' @> ${ASKED_MARK}::jsonb
       ORDER BY q.project_id, q.created_at`),
  );
  const standingsOf = new Map<string, Awaited<ReturnType<typeof openStandings>>>();
  for (const q of open) {
    try {
      await voidQuestionAs({
        questionId: q.id,
        userId: await stewardAccountOf(q.project_id),
        agency: 'agent',
        reason: VOID_REASON,
      });
      report.voided += 1;
      const all = standingsOf.get(q.project_id) ?? (await openStandings(q.project_id));
      standingsOf.set(q.project_id, all);
      const now = all.find((x) =>
        q.issue_id
          ? x.subject.kind === 'issue' && x.subject.id === q.issue_id
          : x.subject.kind === 'requirement' && x.subject.id === q.requirement_id,
      );
      const stuck = now?.stuck;
      if (now && stuck) {
        await db.transaction((tx) =>
          emitEvent(tx, 'standing.stuck', {
            projectId: q.project_id,
            subject: now.subject,
            basis: now.basis,
            code: stuck.code,
          }),
        );
        report.rediagnosed += 1;
      }
    } catch (err) {
      report.refusals.push({
        questionId: q.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (report.refusals.length === 0) {
    await db.transaction((tx) => markBackfillIn(tx, STALE_DRAFT_RETIRE_KEY, report));
  }
  return report;
}
