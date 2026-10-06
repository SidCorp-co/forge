/**
 * The contract waits' face on the ecosystem side (REQ-9 BC-1, E1): which contract a wait may name,
 * which approved version settles it, and the view the issue's waits read as. The rows themselves
 * are the issue kernel's (`issues/contract-waits.ts`); this module resolves what they point at.
 */

import {
  CONTRACT_WAIT_UNSETTLED,
  type ContractWaitRefusal,
  type ContractWaitView,
  type IssueContractWaits,
} from '@forge/contracts/contract-waits';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { db, type Tx } from '../../db/client.js';
import {
  type ContractWaitRow,
  contractWaitById,
  contractWaitsOfIssues,
  insertContractWaitIn,
  issueDisplayIds,
  liveWaitOn,
  retractContractWaitIn,
} from '../../issues/index.js';
import {
  contractLockKey,
  type WaitTargetInput,
  type WaitTargetOutcome,
} from '../../lib/contract-versions.js';
import { interfaceContractsOf } from '../interface-contracts.js';
import { heldInterface } from '../interface-service.js';
import { readInterfaces } from '../interface-store.js';
import { lockKeys, projectsWhere } from '../store.js';
import { compareVersions, parseVersion, type Versioning } from './naming.js';
import { versionsOf } from './store.js';
import { waitTargetOf } from './wait-target.js';
import { providerLiveOf } from './waits-live.js';

type Reader = Tx;

export async function versioningOf(
  executor: Reader,
  providerId: string,
): Promise<Versioning | null> {
  const row = (await readInterfaces(executor, [providerId])).get(providerId);
  return row ? heldInterface(row, providerId).document.commitments.versioning : null;
}

/** Approved versions of one contract, newest recorded first. */
export async function approvedVersionsOf(
  executor: Reader,
  providerId: string,
  contractSlug: string,
) {
  return (await versionsOf(executor, [providerId], contractSlug)).filter(
    (v) => v.approval === 'approved',
  );
}

// The newest approved version at or above `min` in the provider's own scheme; none without a scheme.
export async function settlingContractVersion(
  executor: Reader,
  providerId: string,
  contractSlug: string,
  minVersion: string,
): Promise<string | null> {
  const versioning = await versioningOf(executor, providerId);
  if (!versioning || !parseVersion(versioning, minVersion)) return null;
  const approved = await approvedVersionsOf(executor, providerId, contractSlug);
  return (
    approved.find((v) => compareVersions(versioning, v.version, minVersion) >= 0)?.version ?? null
  );
}

export interface WaitTarget {
  issue: { id: string; projectId: string; status: string };
  contract: string;
  minVersion: string;
}

/** One wait's fields checked through `executor`, so a caller's transaction reads what it writes. */
export async function contractWaitTargetIn(
  executor: Reader,
  t: WaitTargetInput,
  now: Date,
): Promise<WaitTargetOutcome> {
  const own = (await interfaceContractsOf(t.projectId, executor)) ?? {
    publishes: [],
    consumes: [],
  };
  const known = [...own.publishes, ...own.consumes];
  const [providerSlug] = t.contract.split('/') as [string];
  const [provider] = known.includes(t.contract)
    ? await projectsWhere(executor, { slugs: [providerSlug] })
    : [];
  const versioning = provider ? await versioningOf(executor, provider.id) : null;
  return waitTargetOf(
    t,
    { known, provider: provider ? { id: provider.id, slug: provider.slug } : null, versioning },
    now,
  );
}

type Outcome<T> = { ok: true; value: T } | { ok: false; refusals: ContractWaitRefusal[] };

export async function addContractWait(
  t: WaitTarget & { reason: string | null; dueAt?: string | undefined; userId: string },
): Promise<Outcome<ContractWaitRow>> {
  if ((ISSUE_TERMINAL_STATUSES as readonly string[]).includes(t.issue.status)) {
    return {
      ok: false,
      refusals: [
        {
          code: 'CONTRACT_WAIT_ISSUE_FINISHED',
          path: '',
          detail: `the issue is ${t.issue.status}; a finished issue is dispatched no more, so it waits on no contract version.`,
        },
      ],
    };
  }
  const target = await contractWaitTargetIn(
    db,
    {
      projectId: t.issue.projectId,
      contract: t.contract,
      minVersion: t.minVersion,
      dueAt: t.dueAt,
    },
    new Date(),
  );
  if (!target.ok) return target;
  const resolved = target.value;
  return db.transaction(async (tx): Promise<Outcome<ContractWaitRow>> => {
    await lockKeys(tx, [contractLockKey(resolved.providerProjectId, resolved.contractSlug)]);
    const held = await liveWaitOn(tx, {
      issueId: t.issue.id,
      providerProjectId: resolved.providerProjectId,
      contractSlug: resolved.contractSlug,
    });
    if (held) {
      return {
        ok: false,
        refusals: [
          {
            code: 'CONTRACT_WAIT_DUPLICATE',
            path: '/contract',
            detail: `this issue already waits on ${t.contract} >= ${held.minVersion} (wait ${held.id}); retract it first to wait on another version.`,
          },
        ],
      };
    }
    const row = await insertContractWaitIn(tx, {
      projectId: t.issue.projectId,
      issueId: t.issue.id,
      providerProjectId: resolved.providerProjectId,
      contractSlug: resolved.contractSlug,
      minVersion: t.minVersion,
      reason: t.reason,
      createdBy: t.userId,
      dueAt: resolved.dueAt,
    });
    return { ok: true, value: row };
  });
}

export async function retractContractWait(input: {
  issueId: string;
  waitId: string;
  reason: string;
  userId: string;
}): Promise<Outcome<ContractWaitRow> | null> {
  const wait = await contractWaitById(db, input.waitId);
  if (!wait || wait.issueId !== input.issueId) return null;
  if (wait.retractedAt) {
    return {
      ok: false,
      refusals: [
        {
          code: 'CONTRACT_WAIT_RETRACTED',
          path: '/wait',
          detail: `wait ${wait.id} was retracted at ${wait.retractedAt.toISOString()}; a retracted wait stays as it was, and a new one is added instead.`,
        },
      ],
    };
  }
  const row = await db.transaction((tx) =>
    retractContractWaitIn(tx, wait.id, { userId: input.userId, reason: input.reason }),
  );
  return row ? { ok: true, value: row } : retractContractWait(input);
}

/** Each wait as the issue reads it, with the provider's newest approved version and its live reading. */
export async function contractWaitViews(
  rows: readonly ContractWaitRow[],
  opts: { live: boolean },
): Promise<ContractWaitView[]> {
  if (rows.length === 0) return [];
  const providers = new Map(
    (await projectsWhere(db, { ids: [...new Set(rows.map((r) => r.providerProjectId))] })).map(
      (p) => [p.id, p],
    ),
  );
  const shown = await issueDisplayIds([...new Set(rows.map((r) => r.issueId))]);
  const out: ContractWaitView[] = [];
  for (const r of rows) {
    const provider = providers.get(r.providerProjectId);
    const slug = provider?.slug ?? r.providerProjectId;
    const contract = `${slug}/${r.contractSlug}`;
    const inProject = r.providerProjectId === r.projectId;
    const [current] = await approvedVersionsOf(db, r.providerProjectId, r.contractSlug);
    out.push({
      id: r.id,
      issue: shown.get(r.issueId) ?? r.issueId,
      contract,
      provider: { id: r.providerProjectId, slug },
      inProject,
      minVersion: r.minVersion,
      reason: r.reason,
      settled: r.settledAt !== null,
      settledVersion: r.settledVersion,
      settledAt: r.settledAt?.toISOString() ?? null,
      current: current?.version ?? null,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      retractedAt: r.retractedAt?.toISOString() ?? null,
      retractReason: r.retractReason,
      dueAt: r.dueAt?.toISOString() ?? null,
      providerLive: opts.live && !inProject && !r.retractedAt ? await providerLiveOf(r) : null,
    });
  }
  return out;
}

export async function issueContractWaits(
  issueId: string,
  opts: { live: boolean },
): Promise<IssueContractWaits> {
  const waits = await contractWaitViews(await contractWaitsOfIssues([issueId]), opts);
  const held = waits.filter((w) => !w.settled && !w.retractedAt);
  return {
    waits,
    dispatchable: held.length === 0,
    refusal:
      held.length === 0
        ? null
        : {
            code: CONTRACT_WAIT_UNSETTLED,
            detail: held
              .map(
                (w) =>
                  `${w.issue} waits on ${w.contract} >= ${w.minVersion}, and its provider has approved ${w.current ?? 'no version'}.`,
              )
              .join(' '),
          },
  };
}
