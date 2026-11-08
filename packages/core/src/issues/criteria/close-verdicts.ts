/**
 * The close as its builder's verdict (owner 2026-11-08, D2). Where the project judges its own work
 * (its judge, `verified-rule.ts:verifiedJudgeOf`, is not `independent`), an issue closed met in scope
 * has met each criterion it did not move out: so each live criterion tracing a business criterion
 * that holds no verdict at the issue's landing is recorded passing at the close, at that landing, by
 * whoever closed it. Its reason names the close as its source, and it carries no QA judge, so it is
 * never shown as an independent judge's. A criterion the close moved out (`unmet`) was retired by the
 * close and is never read here. Under an independent judge nothing is recorded: that judge still owes it.
 *
 * The landing is the commit the issue's mark names (`mark-trail.ts:markedCommitSql`): an observed
 * merge's, else the commit its asserted mark claims. On a project with no source host every mark is
 * asserted and `merged_commit_sha` stays empty, so reading only that column recorded nothing there.
 * A verdict at an earlier landing, or on a runtime, does not hold the close's landing: a fail that
 * sent the issue back is answered by the close that met it again. A verdict written after the close
 * (a judge's reading of it) is never overridden.
 *
 * Before this, every such criterion owed "judge BC-x on ISS-y" on its requirement for ever, though no
 * judge was coming (G2). `backfillCloseVerdicts` records the same for issues closed before it.
 */

import type { ActorAgency } from '@forge/contracts/permissions';
import type { VerifiedJudge } from '@forge/contracts/verified-rule';
import { sql } from 'drizzle-orm';
import { backfillMarkedIn, markBackfillIn } from '../../db/backfill-markers.js';
import { db, type Tx } from '../../db/client.js';
import { rowsOf } from '../../db/raw-sql.js';
import { keepBuilderFacts } from '../builder-facts.js';
import { markedCommitSql } from '../mark-trail.js';
import { readJudge } from '../ports.js';

/** The reason a close's verdict carries: its source, which every reader shows beside it. */
export const CLOSE_VERDICT_REASON =
  "met in scope at the issue's close: the project judges its own work, so the close is its builder's verdict";

/** Whether a close records its traced criteria's verdicts on a project whose judge is `judge`. */
export const closeRecordsVerdicts = (judge: VerifiedJudge | null): boolean =>
  judge !== null && judge !== 'independent';

/** The inserted rows of one close, or of the backfill over many: the issue each came from. */
const insertCloseVerdicts = (where: ReturnType<typeof sql>, by: ReturnType<typeof sql>) => sql`
  INSERT INTO criterion_verdicts
    (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha, author_user_id, author_agency)
  SELECT c.id, c.issue_id, 'pass', ${CLOSE_VERDICT_REASON}, 'commit', m.sha, ${by}
    FROM issue_criteria c
    JOIN issues i ON i.id = c.issue_id
    CROSS JOIN LATERAL (SELECT ${markedCommitSql(sql`i`)} AS sha) m
    CROSS JOIN LATERAL (
      SELECT max(t.created_at) AS at FROM kernel_transitions t
       WHERE t.entity = 'issue' AND t.entity_id = i.id AND t.to_status = 'closed') closed
   WHERE ${where}
     AND i.status = 'closed'
     AND c.retired_at IS NULL
     AND c.requirement_criterion_id IS NOT NULL
     AND m.sha ~ '^[0-9a-f]{40}$'
     AND NOT EXISTS (
       SELECT 1 FROM criterion_verdicts v
        WHERE v.criterion_id = c.id
          AND (lower(v.commit_sha) = m.sha OR (closed.at IS NOT NULL AND v.created_at > closed.at)))
  RETURNING issue_id`;

/**
 * Records the close's verdicts on `issueId`, inside the close's own transaction, after its move.
 * Returns how many it recorded. An issue whose mark names no whole commit records none: nothing names
 * the build the close met its criteria on, so they stay owed.
 */
export async function recordCloseVerdicts(
  tx: Tx,
  issueId: string,
  closer: { userId: string; agency: ActorAgency },
): Promise<number> {
  const rows = rowsOf<{ issue_id: string }>(
    await tx.execute(
      insertCloseVerdicts(
        sql`c.issue_id = ${issueId}`,
        sql`${closer.userId}::uuid, ${closer.agency}`,
      ),
    ),
  );
  // the builder rule is computed as a verdict is written, inside its transaction (`builder-facts.ts`)
  if (rows.length > 0) await keepBuilderFacts(tx, [issueId]);
  return rows.length;
}

/** The second pass: the first (`d2-close-verdicts`) read only an observed merge's commit, so it wrote
 *  nothing for an asserted mark and skipped every criterion holding an older verdict. */
export const CLOSE_VERDICTS_BACKFILL_KEY = 'd2-close-verdicts-marked';

export interface CloseVerdictsBackfill {
  projects: number;
  issues: number;
  verdicts: number;
  /** Projects left out because an independent judge owes their criteria. */
  independent: number;
}

/**
 * The same verdicts for every issue already closed whose traced criteria hold none at its landing, on
 * each project whose judge is not independent: once, gated by its marker, and idempotent besides (a
 * criterion holding a verdict at that landing is never written again). Each verdict is the closer's account where the move
 * to closed names one, else the issue's filer's, recorded as an agent's.
 */
export async function backfillCloseVerdicts(): Promise<CloseVerdictsBackfill | null> {
  if (await db.transaction((tx) => backfillMarkedIn(tx, CLOSE_VERDICTS_BACKFILL_KEY))) return null;
  const projects = rowsOf<{ project_id: string }>(
    await db.execute(sql`
      SELECT DISTINCT i.project_id
        FROM issue_criteria c JOIN issues i ON i.id = c.issue_id
       WHERE i.status = 'closed' AND c.retired_at IS NULL AND c.requirement_criterion_id IS NOT NULL`),
  );
  const report: CloseVerdictsBackfill = { projects: 0, issues: 0, verdicts: 0, independent: 0 };
  for (const { project_id } of projects) {
    if (!closeRecordsVerdicts(await readJudge(project_id))) {
      report.independent += 1;
      continue;
    }
    const rows = await db.transaction(async (tx) => {
      const written = rowsOf<{ issue_id: string }>(
        await tx.execute(
          insertCloseVerdicts(
            sql`i.project_id = ${project_id}`,
            sql`coalesce(
              (SELECT t.actor_id FROM kernel_transitions t
                WHERE t.entity = 'issue' AND t.entity_id = i.id AND t.to_status = 'closed'
                  AND t.actor_type = 'user' AND t.actor_id IS NOT NULL
                ORDER BY t.created_at DESC LIMIT 1),
              i.created_by_id), 'agent'`,
          ),
        ),
      );
      await keepBuilderFacts(
        tx,
        written.map((r) => r.issue_id),
      );
      return written;
    });
    report.projects += 1;
    report.verdicts += rows.length;
    report.issues += new Set(rows.map((r) => r.issue_id)).size;
  }
  await db.transaction((tx) => markBackfillIn(tx, CLOSE_VERDICTS_BACKFILL_KEY, report));
  return report;
}
