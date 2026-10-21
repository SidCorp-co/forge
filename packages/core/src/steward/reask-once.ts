// The one-off for the steward's questions asked before its decisions were fixed (REQ-48 BC-5, dev.268):
// each open question whose options the model spelled is voided, naming why, and the item the run that
// asked was on is diagnosed again where it still reads stuck, so the steward asks with Forge's own
// options, or asks nothing where the wait is already somebody's act. Gated by its `backfill_markers`
// row; a question it could not void is reported and leaves the marker unset, so the next boot retries.

import { STEWARD_DECISION_OPTION_IDS } from '@forge/contracts/steward';
import { eq, sql } from 'drizzle-orm';
import { backfillMarkedIn, markBackfillIn } from '../db/backfill-markers.js';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { stewardRuns } from '../db/schema-steward-runs.js';
import { emitEvent } from '../outbox/index.js';
import { voidQuestionAs } from '../questions/index.js';
import { stewardAccountOf } from './account.js';
import { fingerprintOf } from './door-decide.js';
import { openStandings } from './ports.js';

export const STEWARD_REASK_KEY = 'steward-free-form-questions-reask';

const VOID_REASON =
  "The steward asked this with options it spelled itself, before its decisions were fixed (REQ-48). It asks again with Forge's own options where the item still waits on a decision, and not at all where the wait is already somebody's act.";

export interface ReaskReport {
  voided: number;
  reasked: number;
  refusals: { questionId: string; reason: string }[];
}

interface FreeFormRow {
  id: string;
  project_id: string;
  fingerprint: string;
}

/** Open steward questions whose current round is not the fixed set. */
async function freeFormQuestions(): Promise<FreeFormRow[]> {
  const mark = JSON.stringify([{ id: STEWARD_DECISION_OPTION_IDS.drop }]);
  return rowsOf<FreeFormRow>(
    await db.execute(sql`
      SELECT q.id, q.project_id, q.steps -> -1 -> 'options' -> 0 ->> 'fingerprint' AS fingerprint
        FROM agent_questions q
       WHERE q.status = 'open'
         AND q.steps -> -1 -> 'options' -> 0 ->> 'fingerprint' LIKE 'steward:%'
         AND NOT (q.steps -> -1 -> 'options' @> ${mark}::jsonb)
       ORDER BY q.project_id, q.created_at`),
  );
}

/**
 * Each question's item is diagnosed again before the question is voided, so a stop between the two
 * leaves the question open, and the next boot emits again (folding into the same run) and voids it.
 */
export async function runStewardReaskOnce(): Promise<ReaskReport | null> {
  if (await db.transaction((tx) => backfillMarkedIn(tx, STEWARD_REASK_KEY))) return null;
  const report: ReaskReport = { voided: 0, reasked: 0, refusals: [] };
  const standingsOf = new Map<string, Awaited<ReturnType<typeof openStandings>>>();
  const emitted = new Set<string>();
  for (const q of await freeFormQuestions()) {
    try {
      const runId = fingerprintOf(q.fingerprint)?.runId;
      const [run] = runId
        ? await db.select().from(stewardRuns).where(eq(stewardRuns.id, runId)).limit(1)
        : [];
      const subject = run ? `${run.subjectKind}:${run.subjectId}` : null;
      if (run && subject && !emitted.has(subject)) {
        const all = standingsOf.get(run.projectId) ?? (await openStandings(run.projectId));
        standingsOf.set(run.projectId, all);
        const now = all.find(
          (x) => x.subject.kind === run.subjectKind && x.subject.id === run.subjectId,
        );
        const stuck = now?.stuck;
        if (now && stuck) {
          await db.transaction((tx) =>
            emitEvent(tx, 'standing.stuck', {
              projectId: run.projectId,
              subject: now.subject,
              basis: now.basis,
              code: stuck.code,
            }),
          );
          report.reasked += 1;
        }
        emitted.add(subject);
      }
      await voidQuestionAs({
        questionId: q.id,
        userId: await stewardAccountOf(q.project_id),
        agency: 'agent',
        reason: VOID_REASON,
      });
      report.voided += 1;
    } catch (err) {
      report.refusals.push({
        questionId: q.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (report.refusals.length === 0) {
    await db.transaction((tx) => markBackfillIn(tx, STEWARD_REASK_KEY, report));
  }
  return report;
}
