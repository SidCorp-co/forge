/**
 * Whether an issue's requirement changed since its plan was written (workflow
 * requirement-to-delivery, step `impact`): read for the issue reads and for the awaiting_release
 * guard alike, so the flag a reader sees is the one the gate refuses on.
 */

import { changedSincePlan } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';

interface PlanDrift {
  key: string;
  plannedRevision: number | null;
  currentRevision: number | null;
  changed: boolean;
  /** Changed only by a re-pin of the same revision onto newly approved designs or contracts. */
  repinned: boolean;
  detail: string;
}

/** The plan drift of `issueId`, or null when it delivers no requirement. */
export async function planDriftOf(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
): Promise<PlanDrift | null> {
  const [r] = (await executor.execute(sql`
    SELECT r.req_seq, r.current_revision, i.planned_revision, i.planned_baseline_seq,
           CASE WHEN btrim(coalesce(i.plan, '')) <> '' THEN i.plan END AS plan,
           (SELECT max(b.seq) FROM requirement_baselines b
             WHERE b.requirement_id = r.id AND b.revision = r.current_revision) AS latest_baseline_seq
    FROM issues i
    JOIN requirements r ON r.id = i.requirement_id
    WHERE i.id = ${issueId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!r) return null;
  const num = (v: unknown) => (v == null ? null : Number(v));
  const key = `REQ-${Number(r.req_seq)}`;
  const plannedRevision = num(r.planned_revision);
  const currentRevision = num(r.current_revision);
  const changed = changedSincePlan({
    plan: r.plan == null ? null : String(r.plan),
    plannedRevision,
    currentRevision,
    plannedBaselineSeq: num(r.planned_baseline_seq),
    latestBaselineSeq: num(r.latest_baseline_seq),
  });
  const repinned = changed && plannedRevision === currentRevision;
  return {
    key,
    plannedRevision,
    currentRevision,
    changed,
    repinned,
    detail: repinned
      ? `${key} revision ${currentRevision} was re-pinned onto newly approved designs or contracts after this issue's plan was written; re-plan against the latest baseline.`
      : `${key} stands at revision ${currentRevision ?? 'none'}, but this issue's plan was written against ${plannedRevision === null ? 'no revision' : `revision ${plannedRevision}`}; re-plan against the current revision.`,
  };
}
