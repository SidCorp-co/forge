// ISS-55 — the move history a verdict is read against: a criterion that was not passing at an
// issue's latest reopen has no current evidence from before it (`voidedUpTo`, ISS-845), and a release
// that shipped an issue it later withdrew holds nothing.

import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';

/**
 * When each issue last entered `reopen`, read from the move history (`kernel_transitions`); an
 * issue never reopened is absent. A verdict at or before that instant on a criterion it voids
 * (`voidedUpTo`) is not current evidence: the release hold and every coverage reader read it as not
 * judged.
 *
 * A reopen undone is none (ISS-760): one whose first arrival at `awaiting_release` or `closed` after
 * it came straight from `reopen` — the way back a requirement-level fail's reopen takes once the
 * fail is routed past the issue, or a design-only close — rejected no build, since nothing landed
 * between, so the verdicts before it count again. `asReturned` names issues read as if that return
 * happened now: their reopens with no landed arrival since are undone too (the return's own guard,
 * `fail-return.ts`, which asks how the issue would stand once back).
 */
export async function reopenedAtOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
  asReturned: readonly string[] = [],
): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const returned =
    asReturned.length === 0
      ? sql`false`
      : sql`t.entity_id IN (${sql.join(
          asReturned.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const rows = (await executor.execute(sql`
    SELECT t.entity_id, max(t.created_at) AS at
      FROM kernel_transitions t
     WHERE t.entity = 'issue'
       AND t.to_status = 'reopen'
       AND t.entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       AND NOT COALESCE((
             SELECT u.from_status = 'reopen' FROM kernel_transitions u
              WHERE u.entity = 'issue' AND u.entity_id = t.entity_id
                AND u.to_status IN ('awaiting_release', 'closed')
                AND u.created_at > t.created_at
              ORDER BY u.created_at, u.id LIMIT 1),
           ${returned})
     GROUP BY t.entity_id`)) as unknown as Array<{ entity_id: string; at: Date | string }>;
  return new Map([...rows].map((r) => [r.entity_id, new Date(r.at)]));
}

/**
 * The instant at or before which a reopen voids one criterion's verdicts, `newestFirst` its own, or
 * null where it voids none of them (ISS-845, owner 2026-10-31, REQ-79 r6). A reopen rejects the
 * build that failed, not every criterion on it: it voids the criterion whose newest verdict at the
 * reopen was not a pass, and a pass stands across it. Where it counts after that is its build's
 * weighing: carried to a later landing that descends from it, unless what changed between falls
 * under what it covers (`landed-carriage.ts`).
 */
export function voidedUpTo(
  newestFirst: ReadonlyArray<{ verdict: string | null; at: Date | string | null }>,
  reopenedAt: Date | null | undefined,
): Date | null {
  if (!reopenedAt) return null;
  const until = reopenedAt.getTime();
  const atReopen = newestFirst.find((v) => v.at !== null && new Date(v.at).getTime() <= until);
  return atReopen?.verdict === 'pass' ? null : reopenedAt;
}

/**
 * Every move of each issue into `closed`, oldest first, from the move history (`kernel_transitions`);
 * an issue never closed is absent. Only a release closes an issue (`CLOSE_ONLY_BY_RELEASE`), so each
 * is the moment some release shipped it: the release page reads its own among them.
 */
export async function closedAtOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Map<string, Date[]>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await executor.execute(sql`
    SELECT entity_id::text AS issue_id, created_at AS at
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND to_status = 'closed'
       AND entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     ORDER BY created_at ASC`)) as unknown as Array<{ issue_id: string; at: Date | string }>;
  const out = new Map<string, Date[]>();
  for (const r of rows) out.set(r.issue_id, [...(out.get(r.issue_id) ?? []), new Date(r.at)]);
  return out;
}

/**
 * The issues whose ship was withdrawn: the newest move touching `closed` (`kernel_transitions`)
 * took the issue out of it. A release that closed such an issue shipped work its reopen rejected,
 * so no reader takes that release as where the issue's work is until a release closes it again.
 * The release's own roster record is untouched: it still names what that release shipped.
 */
export async function shipsWithdrawnOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const rows = (await executor.execute(sql`
    SELECT DISTINCT ON (entity_id) entity_id::text AS issue_id, from_status = 'closed' AS withdrawn
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND (to_status = 'closed' OR from_status = 'closed')
       AND entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     ORDER BY entity_id, created_at DESC, (from_status = 'closed') DESC`)) as unknown as Array<{
    issue_id: string;
    withdrawn: boolean;
  }>;
  return new Set([...rows].filter((r) => r.withdrawn).map((r) => r.issue_id));
}

/**
 * Which of these issues reached `status` after the instant `at` without standing there at it: a move
 * into it after `at` (`kernel_transitions`), and the newest move at or before `at` took the issue
 * anywhere else, or there was none. An issue with no move into `status` after `at` is absent.
 */
export async function arrivedAfterOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
  status: string,
  at: Date,
): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const atIso = at.toISOString();
  const rows = (await executor.execute(sql`
    SELECT k.entity_id::text AS issue_id
      FROM kernel_transitions k
     WHERE k.entity = 'issue'
       AND k.to_status = ${status}
       AND k.created_at > ${atIso}
       AND k.entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       AND (SELECT p.to_status FROM kernel_transitions p
             WHERE p.entity = 'issue' AND p.entity_id = k.entity_id AND p.created_at <= ${atIso}
             ORDER BY p.created_at DESC LIMIT 1) IS DISTINCT FROM ${status}
     GROUP BY k.entity_id`)) as unknown as Array<{ issue_id: string }>;
  return new Set([...rows].map((r) => r.issue_id));
}

/** A release as a claim on an issue is read: when it was cut, and when it shipped (null where not). */
interface ReleaseClaimSpan {
  openedAt: Date | null;
  releasedAt: Date | null;
}

/** An issue's move history as a release's claim on it is read (`reopenedAtOf`, `closedAtOf`). */
interface IssueRounds {
  reopenedAt: Date | null;
  closedAt: readonly Date[];
}

/**
 * When release `p` claimed the issue. A shipped release claims at its own close of it, the first
 * since its cut; any other release, or one that never closed it, at its cut. A draft claims nothing.
 */
function claimedAt(p: ReleaseClaimSpan, i: Pick<IssueRounds, 'closedAt'>): Date | null {
  const cut = p.openedAt;
  if (cut === null) return null;
  const close = p.releasedAt === null ? undefined : i.closedAt.find((at) => at >= cut);
  return close ?? cut;
}

/**
 * True where the issue was reopened after release `p` claimed it: it carried an earlier round, and
 * its note and its mark now say a later one, which it did not ship (J9 on 0.4.0-dev.224: ISS-455's
 * dev.225 retry fix read as a dev.224 fix). Read against the run's start instead, a reopen inside the
 * window of the release that went on to ship the rework hid that release's own note (J10 on
 * 0.4.0-dev.227: dev.225). The one rule for a release and a reopened issue: the release read names
 * such an issue reworked, and the release line holds it nowhere past that release
 * (`release-batch/released-line.ts:releasedLineOf`, ISS-967), so a criterion of the re-landed round is
 * never owed on, nor counted on, a release that shipped the round before it.
 */
export function reworkedSince(p: ReleaseClaimSpan, i: IssueRounds): boolean {
  const claimed = claimedAt(p, i);
  return claimed !== null && i.reopenedAt !== null && i.reopenedAt > claimed;
}
