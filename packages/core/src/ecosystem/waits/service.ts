import type {
  AddContractWaitRequest,
  ContractWaitRefusal,
  ContractWaitView,
} from '@forge/contracts/contract-waits';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { issueContractWaits } from '../../db/schema-contract-waits.js';
import { effectiveProjectRole } from '../../lib/authz.js';
import { compareVersions, type Versioning } from '../contract/naming.js';
import { lockKeys } from '../store.js';
import {
  approvedVersions,
  liveWaitOn,
  type WaitActor,
  waitRowIn,
  waitTargetOf,
  waitView,
} from './read.js';
import { addRefusals, retractRefusal, settlingVersion, writerRefusal } from './rules.js';

export type WaitOutcome =
  | { ok: true; wait: ContractWaitView; created: boolean }
  | { ok: false; refusals: ContractWaitRefusal[] };

const contractLock = (providerId: string, slug: string) => `contract:${providerId}/${slug}`;

async function writerOf(actor: WaitActor, projectId: string, act: string) {
  const role = (await effectiveProjectRole(actor.userId, projectId))?.role ?? null;
  return writerRefusal({ ...actor, role }, projectId, act);
}

export async function addContractWait(input: {
  issueId: string;
  projectId: string;
  actor: WaitActor;
  request: AddContractWaitRequest;
}): Promise<WaitOutcome> {
  const { issueId, projectId, actor, request } = input;
  const denied = await writerOf(actor, projectId, 'adding a contract wait');
  if (denied) return { ok: false, refusals: [denied] };
  const { target, requestId } = await waitTargetOf({
    consumerId: projectId,
    issueId,
    contract: request.contract,
    minVersion: request.minVersion,
    request: request.request,
  });
  const early = addRefusals(target);
  if (early.length > 0 || !target.provider || !target.versioning) {
    return { ok: false, refusals: early };
  }
  const provider = target.provider;
  const versioning = target.versioning;
  return db.transaction(async (tx): Promise<WaitOutcome> => {
    // cm:why the lock a version decision takes, so a wait added while a version is approved settles exactly once
    await lockKeys(tx, [contractLock(provider.id, target.contractSlug)]);
    const duplicate = await liveWaitOn(tx, issueId, provider.id, target.contractSlug);
    const late = addRefusals({ ...target, duplicate });
    if (late.length > 0) return { ok: false, refusals: late };
    const settled = settlingVersion(
      versioning,
      request.minVersion,
      await approvedVersions(tx, provider.id, target.contractSlug),
    );
    const [row] = await tx
      .insert(issueContractWaits)
      .values({
        projectId,
        issueId,
        providerProjectId: provider.id,
        contractSlug: target.contractSlug,
        minVersion: request.minVersion,
        reason: request.reason ?? null,
        contractRequestId: requestId,
        createdBy: actor.userId,
        createdAgency: actor.agency,
        settledVersion: settled,
        settledAt: settled ? sql`now()` : null,
      })
      .returning({ id: issueContractWaits.id });
    if (!row) throw new Error('contract waits: the insert returned no row');
    return { ok: true, wait: await waitView(tx, projectId, row.id), created: true };
  });
}

export async function retractContractWait(input: {
  issueId: string;
  projectId: string;
  waitId: string;
  actor: WaitActor;
  reason: string;
}): Promise<WaitOutcome | null> {
  const { issueId, projectId, waitId, actor } = input;
  const denied = await writerOf(actor, projectId, 'retracting a contract wait');
  if (denied) return { ok: false, refusals: [denied] };
  return db.transaction(async (tx): Promise<WaitOutcome | null> => {
    const row = await waitRowIn(tx, issueId, waitId);
    if (!row) return null;
    const refusal = retractRefusal(row);
    if (refusal) return { ok: false, refusals: [refusal] };
    await tx
      .update(issueContractWaits)
      .set({
        retractedAt: sql`now()`,
        retractedBy: actor.userId,
        retractedAgency: actor.agency,
        retractReason: input.reason.trim(),
      })
      .where(eq(issueContractWaits.id, row.id));
    return { ok: true, wait: await waitView(tx, projectId, row.id), created: false };
  });
}

export async function settleContractWaitsIn(
  tx: Tx,
  input: { providerId: string; contractSlug: string; version: string; versioning: Versioning },
): Promise<string[]> {
  const open = await tx
    .select({ id: issueContractWaits.id, minVersion: issueContractWaits.minVersion })
    .from(issueContractWaits)
    .where(
      and(
        eq(issueContractWaits.providerProjectId, input.providerId),
        eq(issueContractWaits.contractSlug, input.contractSlug),
        isNull(issueContractWaits.retractedAt),
        isNull(issueContractWaits.settledAt),
      ),
    );
  const met = open
    .filter((w) => compareVersions(input.versioning, input.version, w.minVersion) >= 0)
    .map((w) => w.id);
  if (met.length === 0) return [];
  await tx
    .update(issueContractWaits)
    .set({ settledVersion: input.version, settledAt: sql`now()` })
    .where(inArray(issueContractWaits.id, met));
  return met;
}
