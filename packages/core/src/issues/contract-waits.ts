/**
 * An issue's waits on `contract >= version` (REQ-9 BC-1, E1; requirement-to-delivery
 * `contract-first`): the store, the dispatch gate every door asks, and the settle the approving
 * transaction writes.
 *
 * One predicate (`db/schema-contract-waits.ts:contractWaitUnsettledSql`), asked the ways the design
 * gate is (`workflows/build-gate.ts`): the admissible list leaves a held issue out, a run session or
 * a pool job over it is refused by name (CONTRACT_WAIT_UNSETTLED), and a queued job names it as its
 * dispatch gate. A wait is released by the version approval's own transaction, never by a poll.
 */

import { CONTRACT_WAIT_UNSETTLED } from '@forge/contracts/contract-waits';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { contractWaitUnsettledSql, issueContractWaits } from '../db/schema-contract-waits.js';
import { lockXact } from '../lib/advisory-lock.js';
import { contractLockKey } from '../lib/contract-versions.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError } from '../lib/refusal.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { type GateReader, settlingContractVersion } from './ports.js';

export { contractWaitUnsettledSql };

export type ContractWaitRow = typeof issueContractWaits.$inferSelect;

export interface UnsettledWait {
  issue: string;
  contract: string;
  minVersion: string;
  /** The deadline the wait is worked to, where one was set. */
  dueAt?: Date | null;
}

export function unsettledDetail(w: UnsettledWait): string {
  const due = w.dueAt ? ` It is due by ${w.dueAt.toISOString()}.` : '';
  return `${w.issue} waits on ${w.contract} >= ${w.minVersion}, which no approved version settles yet; it is dispatched once the provider approves a version at or above it.${due}`;
}

/** The dispatch doors' refusal, one per held wait, in the envelope every door answers with. */
export function contractWaitUnsettled(held: readonly UnsettledWait[]): RefusalError {
  return new RefusalError(
    held.map((w) => ({ code: CONTRACT_WAIT_UNSETTLED, path: '', detail: unsettledDetail(w) })),
    CONTRACT_WAIT_UNSETTLED,
  );
}

async function heldWhere(
  projectId: string,
  filter: SQL,
  executor: GateReader = db,
): Promise<UnsettledWait[]> {
  const rows = (await executor.execute(sql`
    SELECT i.iss_seq, p.slug AS provider_slug, cw.contract_slug, cw.min_version, cw.due_at
    FROM issue_contract_waits cw
    JOIN issues i ON i.id = cw.issue_id
    JOIN projects p ON p.id = cw.provider_project_id
    WHERE cw.project_id = ${projectId}
      AND cw.retracted_at IS NULL
      AND cw.settled_at IS NULL
      AND ${filter}
    ORDER BY i.iss_seq, cw.created_at
  `)) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const prefix = await activeIssuePrefix(projectId, executor);
  return rows.map((r) => ({
    issue: formatIssueRef(prefix, Number(r.iss_seq)),
    contract: `${String(r.provider_slug)}/${String(r.contract_slug)}`,
    minVersion: String(r.min_version),
    dueAt: r.due_at ? new Date(r.due_at as string | Date) : null,
  }));
}

function refuseHeld(held: UnsettledWait[]): void {
  if (held.length > 0) throw contractWaitUnsettled(held);
}

/** Refuses a run over these issues (by sequence number) while any waits on an unsettled contract version. */
export async function assertContractWaitsSettledForSeqs(
  projectId: string,
  seqs: readonly number[],
): Promise<void> {
  if (seqs.length === 0) return;
  const list = sql.join(
    seqs.map((n) => sql`${n}`),
    sql`, `,
  );
  refuseHeld(await heldWhere(projectId, sql`i.iss_seq IN (${list})`));
}

/** The issue read's answer: whether a contract wait holds it, and the refusal a dispatch door would give. */
export async function contractWaitHoldOf(projectId: string, issueId: string) {
  const held = await heldWhere(projectId, sql`i.id = ${issueId}`);
  return {
    dispatchable: held.length === 0,
    refusal:
      held.length === 0
        ? null
        : { code: CONTRACT_WAIT_UNSETTLED, detail: held.map(unsettledDetail).join(' ') },
  };
}

export async function assertContractWaitsSettledForIssue(
  projectId: string,
  issueId: string,
  executor: GateReader = db,
): Promise<void> {
  refuseHeld(await heldWhere(projectId, sql`i.id = ${issueId}`, executor));
}

export interface NewContractWait {
  projectId: string;
  issueId: string;
  providerProjectId: string;
  contractSlug: string;
  minVersion: string;
  reason: string | null;
  createdBy: string;
  /** The end of the provider's commitment window, where a breaking version's feedback asked for the wait. */
  dueAt?: Date | null;
}

/** The live (unretracted) wait this issue already holds on the contract, if any. */
export async function liveWaitOn(
  executor: Pick<Tx, 'select'>,
  w: Pick<NewContractWait, 'issueId' | 'providerProjectId' | 'contractSlug'>,
): Promise<ContractWaitRow | null> {
  const [row] = await executor
    .select()
    .from(issueContractWaits)
    .where(
      and(
        eq(issueContractWaits.issueId, w.issueId),
        eq(issueContractWaits.providerProjectId, w.providerProjectId),
        eq(issueContractWaits.contractSlug, w.contractSlug),
        isNull(issueContractWaits.retractedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Takes the locks an approval settles waits under, one per contract, in key order, so writers of
 * several waits never take two of them in opposite orders.
 */
export async function lockContractsIn(
  tx: Tx,
  contracts: readonly { providerProjectId: string; contractSlug: string }[],
): Promise<void> {
  const keys = new Set(contracts.map((c) => contractLockKey(c.providerProjectId, c.contractSlug)));
  for (const key of [...keys].sort()) await lockXact(tx, 'ecosystem', key);
}

/**
 * Writes the wait and, where an approved version already reaches it, settles it in the same
 * transaction, so a wait on a version that already exists never holds its issue. It holds the
 * contract's lock, the one an approval settles waits under, so neither misses the other; a writer of
 * several waits takes them all first through `lockContractsIn`.
 */
export async function insertContractWaitIn(tx: Tx, w: NewContractWait): Promise<ContractWaitRow> {
  await lockContractsIn(tx, [w]);
  const settled = await settlingContractVersion(
    tx,
    w.providerProjectId,
    w.contractSlug,
    w.minVersion,
  );
  const [row] = await tx
    .insert(issueContractWaits)
    .values({
      ...w,
      ...(settled ? { settledVersion: settled, settledAt: new Date() } : {}),
    })
    .returning();
  if (!row) throw new Error(`contract wait on ${w.contractSlug} was not written`);
  return row;
}

export interface SettledWait {
  waitId: string;
  issueId: string;
  projectId: string;
}

/**
 * The approval of `version` settles every open wait on its contract that it reaches. Called inside
 * the approving transaction, under that contract's lock; `reaches(min)` is the provider's own scheme.
 */
export async function settleContractWaitsIn(
  tx: Tx,
  v: {
    providerProjectId: string;
    contractSlug: string;
    version: string;
    reaches: (minVersion: string) => boolean;
  },
): Promise<SettledWait[]> {
  const open = await tx
    .select({
      id: issueContractWaits.id,
      issueId: issueContractWaits.issueId,
      projectId: issueContractWaits.projectId,
      minVersion: issueContractWaits.minVersion,
    })
    .from(issueContractWaits)
    .where(
      and(
        eq(issueContractWaits.providerProjectId, v.providerProjectId),
        eq(issueContractWaits.contractSlug, v.contractSlug),
        isNull(issueContractWaits.retractedAt),
        isNull(issueContractWaits.settledAt),
      ),
    );
  const reached = open.filter((w) => v.reaches(w.minVersion));
  if (reached.length === 0) return [];
  await tx
    .update(issueContractWaits)
    .set({ settledVersion: v.version, settledAt: new Date() })
    .where(
      inArray(
        issueContractWaits.id,
        reached.map((w) => w.id),
      ),
    );
  return reached.map((w) => ({ waitId: w.id, issueId: w.issueId, projectId: w.projectId }));
}

export async function retractContractWaitIn(
  tx: Tx,
  waitId: string,
  by: { userId: string; reason: string },
): Promise<ContractWaitRow | null> {
  const [row] = await tx
    .update(issueContractWaits)
    .set({ retractedAt: new Date(), retractedBy: by.userId, retractReason: by.reason })
    .where(and(eq(issueContractWaits.id, waitId), isNull(issueContractWaits.retractedAt)))
    .returning();
  return row ?? null;
}

export async function contractWaitById(
  executor: Pick<Tx, 'select'>,
  waitId: string,
): Promise<ContractWaitRow | null> {
  const [row] = await executor
    .select()
    .from(issueContractWaits)
    .where(eq(issueContractWaits.id, waitId))
    .limit(1);
  return row ?? null;
}

export async function contractWaitsOfIssues(
  issueIds: readonly string[],
  executor: Pick<Tx, 'select'> = db,
): Promise<ContractWaitRow[]> {
  if (issueIds.length === 0) return [];
  return executor
    .select()
    .from(issueContractWaits)
    .where(inArray(issueContractWaits.issueId, [...issueIds]))
    .orderBy(issueContractWaits.createdAt);
}

/** The issues a version approval settled a wait for, to wake their projects' masters. */
export async function issuesSettledBy(v: {
  providerProjectId: string;
  contractSlug: string;
  version: string;
}): Promise<Array<{ issueId: string; projectId: string; status: string; held: boolean }>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT i.id, i.project_id, i.status,
           ${contractWaitUnsettledSql(sql`i.id`)} AS held
    FROM issue_contract_waits cw
    JOIN issues i ON i.id = cw.issue_id
    WHERE cw.provider_project_id = ${v.providerProjectId}
      AND cw.contract_slug = ${v.contractSlug}
      AND cw.settled_version = ${v.version}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    issueId: String(r.id),
    projectId: String(r.project_id),
    status: String(r.status),
    held: r.held === true,
  }));
}
