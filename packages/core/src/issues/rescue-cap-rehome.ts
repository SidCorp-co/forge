import { sql } from 'drizzle-orm';
import { backfillMarkedIn, markBackfillIn } from '../db/backfill-markers.js';
import { type Db, db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { applyStatusTransition } from './apply-transition.js';
import { projectCreatorOf } from './ports.js';

/** The `backfill_markers` key set once no issue waits on a person for a run-sessions-spent park. */
export const RESCUE_CAP_REHOME_KEY = 'rescue-cap-rehome';

/**
 * What a rescue-cap park says after its count. `pipeline/autonomous-rescue-cap.ts` writes the reason
 * as `<n> ${lead}`, so the record of a park already made is read back by the same words: the
 * kernel's own row for the move into `needs_info` is the only place the cap left its mark, because
 * the park's `reason` option is not stored.
 */
export const RESCUE_CAP_REASON_LEAD =
  'run sessions ended on this issue without it moving on, so it has stopped rather than open another';

const RESCUE_CAP_REASON = new RegExp(`^(\\d+) ${RESCUE_CAP_REASON_LEAD}`);

/** The run sessions a park's reason says were spent, or null when the reason is not the cap's. */
export function spentOfRescueCapReason(reason: string | null): number | null {
  const m = reason ? RESCUE_CAP_REASON.exec(reason) : null;
  return m?.[1] ? Number(m[1]) : null;
}

interface RehomeReport {
  /** Issues moved from a person's `needs_info` to the master's `on_hold`. */
  rehomed: number;
  /** `needs_info` rows left where they were: a person's own park, not the cap's. */
  left: number;
  /** Rows that could not be classified or moved, each named; the marker stays unset while any is. */
  refusals: Array<{ issueId: string; reason: string }>;
}

type Executor = Pick<Db, 'execute' | 'transaction'>;

interface Parked {
  id: string;
  project_id: string;
  reopen_count: number;
  to_status: string | null;
  reason: string | null;
}

/**
 * Re-home the issues the rescue cap parked for a person before it parked for the master (REQ-41
 * BC-11): each `needs_info` whose latest kernel move is the cap's goes to `on_hold` through the
 * issue machine's own `paused` edge, as an agent move whose reason says why; the move out of the park
 * withdraws the question that park minted in the same write (`questions/issue-coupling.ts:
 * withdrawParkQuestions`). A person's own `needs_info`, and the other questions on a re-homed issue,
 * stay as they are. A row with no recorded move into `needs_info` cannot be told
 * apart from a person's park, so it is refused by name and the marker stays unset. Returns null
 * when it already ran to completion.
 */
export async function runRescueCapRehomeOnce(conn: Executor = db): Promise<RehomeReport | null> {
  if (await conn.transaction((tx) => backfillMarkedIn(tx, RESCUE_CAP_REHOME_KEY))) return null;

  const parked = (await conn.execute(sql`
    SELECT i.id, i.project_id, i.reopen_count, k.to_status, k.reason
      FROM issues i
      LEFT JOIN LATERAL (
        SELECT to_status, reason FROM kernel_transitions
         WHERE entity = 'issue' AND entity_id = i.id
         ORDER BY created_at DESC, id DESC LIMIT 1
      ) k ON true
     WHERE i.status = 'needs_info'
     ORDER BY i.project_id, i.iss_seq
  `)) as unknown as Parked[];

  const report: RehomeReport = { rehomed: 0, left: 0, refusals: [] };
  for (const row of parked) {
    if (row.to_status !== 'needs_info') {
      report.refusals.push({
        issueId: row.id,
        reason: `it is at needs_info but its latest recorded move is to ${row.to_status ?? 'nothing'}, so whether the rescue cap parked it cannot be read`,
      });
      continue;
    }
    const spent = spentOfRescueCapReason(row.reason);
    if (spent === null) {
      report.left += 1;
      continue;
    }
    try {
      await rehome(row, spent);
      report.rehomed += 1;
    } catch (err) {
      report.refusals.push({ issueId: row.id, reason: refusalOf(err) });
    }
  }

  if (report.refusals.length === 0) {
    await conn.transaction((tx) => markBackfillIn(tx, RESCUE_CAP_REHOME_KEY));
  }
  return report;
}

async function rehome(row: Parked, spent: number): Promise<void> {
  const actorId = await projectCreatorOf(row.project_id);
  if (!actorId) throw new Error(`the project of issue ${row.id} has no owner to act as`);
  const why = `${spent} run sessions ended on this issue without it moving on, and it was parked for a person before a run that spends its sessions waited on its master; it now waits on its master, who resumes it once with a changed brief, drops it, or asks a person a question carrying a recommended answer.`;
  await applyStatusTransition(
    {
      id: row.id,
      projectId: row.project_id,
      status: 'needs_info' satisfies IssueStatus,
      reopenCount: row.reopen_count,
    },
    'on_hold',
    { id: actorId, ownerId: actorId },
    {
      reason: 'autonomous_rescue_cap_rehomed',
      transitionReason: why,
    },
  );
}

function refusalOf(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error) return err.cause.message;
  return err instanceof Error ? err.message : String(err);
}
