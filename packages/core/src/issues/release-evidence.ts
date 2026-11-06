// ISS-55 — the move history a verdict is read against: a criterion that was not passing at an
// issue's latest reopen has no current evidence from before it (`voidedUpTo`, ISS-845), and a release
// that shipped an issue it later withdrew holds nothing.

import { type SQL, sql } from 'drizzle-orm';
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
 * an issue never closed is absent. A close is the issue met in scope, by the run holding it or by a
 * release that claimed it; the release page reads its own among them, a release's close being the
 * one inside that release's span.
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
 * The shipped release runs of `projectId` still holding the work of the issue `issueId` names: a
 * shipped release whose roster names it (and did not leave it unclosed), or that closed it
 * afterwards, less one a shipped-in correction moved it off (ISS-846), and less one that shipped
 * before the issue last left `closed`: its reopen rejected the work that release carried. Whether an
 * issue's work is live is read here, never off `closed`, which says only that its criteria were met
 * in scope (`pipeline/release-runs.ts:shippedReleasesOf` lists them; `releasedSql` asks whether any).
 */
export function holdingReleaseRunsSql(issueId: SQL, projectId: SQL): SQL {
  const listed = (key: string) =>
    sql`coalesce(r.metadata -> ${key}, '[]'::jsonb) @> to_jsonb(${issueId}::text)`;
  return sql`
    SELECT r.id, r.release_version, r.release_released_at FROM pipeline_runs r
     WHERE r.project_id = ${projectId}
       AND r.release_version IS NOT NULL
       AND r.release_released_at IS NOT NULL
       AND ((${listed('issueIds')} AND NOT ${listed('rosterUnclosed')}) OR ${listed('rosterClosed')})
       AND NOT ${listed('rosterSuperseded')}
       AND NOT EXISTS (
         SELECT 1 FROM kernel_transitions t
          WHERE t.entity = 'issue' AND t.entity_id = ${issueId}::uuid
            AND t.from_status = 'closed' AND t.created_at > r.release_released_at)`;
}

/** True where a shipped release still holds the work of the issue `issueId` names (`holdingReleaseRunsSql`). */
export function releasedSql(issueId: SQL, projectId: SQL): SQL {
  return sql`EXISTS (${holdingReleaseRunsSql(issueId, projectId)})`;
}

/**
 * The issues whose ship was withdrawn: they left `closed` after the last release that carried them
 * shipped, so that release shipped work their reopen rejected, and no reader takes it as where their
 * work is until a release carries them again. An issue its holder closed again after the reopen
 * stays withdrawn: closing says its criteria were met in scope, never that a release shipped it. The
 * release's own roster record is untouched: it still names what that release shipped.
 */
export async function shipsWithdrawnOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const rows = (await executor.execute(sql`
    SELECT DISTINCT t.entity_id::text AS issue_id
      FROM kernel_transitions t
      JOIN issues i ON i.id = t.entity_id
     WHERE t.entity = 'issue'
       AND t.from_status = 'closed'
       AND t.entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       AND NOT ${releasedSql(sql`i.id`, sql`i.project_id`)}`)) as unknown as Array<{
    issue_id: string;
  }>;
  return new Set([...rows].map((r) => r.issue_id));
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

/**
 * An issue's rounds as a release's claim on it is read: its move history (`reopenedAtOf`,
 * `closedAtOf`) and when its current landing was marked (`issues.merged_at`), null where no mark
 * stands now. A reopen leaves the mark; only a cleared mark (`merge-record.ts:clearIssueMerge`) or a
 * re-land, which writes a new one, changes it.
 */
export interface IssueRounds {
  reopenedAt: Date | null;
  closedAt: readonly Date[];
  merged: { at: Date | null };
}

/**
 * The rounds (`IssueRounds`) of each of these issues ever reopened, for a whole release line at once:
 * three statements for the list, never one per issue. An issue never reopened is absent, since no
 * release carried a round of it other than its current one.
 */
export async function reopenedRoundsOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Map<string, IssueRounds>> {
  const reopened = await reopenedAtOf(executor, issueIds);
  const ids = [...reopened.keys()];
  if (ids.length === 0) return new Map();
  const [closed, marks] = await Promise.all([
    closedAtOf(executor, ids),
    executor.execute(sql`
      SELECT id::text AS id, merged_at AS at FROM issues
       WHERE id IN (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`) as unknown as Promise<Array<{ id: string; at: Date | string | null }>>,
  ]);
  const markedAt = new Map([...marks].map((m) => [m.id, m.at === null ? null : new Date(m.at)]));
  return new Map(
    [...reopened].map(([id, reopenedAt]) => [
      id,
      { reopenedAt, closedAt: closed.get(id) ?? [], merged: { at: markedAt.get(id) ?? null } },
    ]),
  );
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
 * True where release `p` carried a round of the issue that is no longer its current one: the issue
 * was reopened after `p` claimed it, AND its current landing was marked after that claim, or no mark
 * stands now (a rework under way). Its note and its mark then say a later round, which `p` did not
 * ship (J9 on 0.4.0-dev.224: ISS-455's dev.225 retry fix read as a dev.224 fix). A reopen whose mark
 * still predates the claim changed nothing `p` shipped: `p` holds the landing it shipped, which is
 * still the current one (ISS-971, FB-497: agenfold's ISS-5, reopened with its mark c633f84 unchanged,
 * had every verdict on 0.133.0 refused). Read against the run's start instead of the release's own
 * close, a reopen inside the window of the release that went on to ship the rework hid that release's
 * own note (J10 on 0.4.0-dev.227: dev.225). The one rule for a release and a reopened issue: the
 * release read names such an issue reworked, and the release line holds it nowhere past that release
 * (`release-batch/released-line.ts:releasedLineOf`, ISS-967), so a criterion of the re-landed round is
 * never owed on, nor counted on, a release that shipped the round before it.
 */
export function reworkedSince(p: ReleaseClaimSpan, i: IssueRounds): boolean {
  const claimed = claimedAt(p, i);
  if (claimed === null || i.reopenedAt === null || i.reopenedAt <= claimed) return false;
  return i.merged.at === null || i.merged.at > claimed;
}
