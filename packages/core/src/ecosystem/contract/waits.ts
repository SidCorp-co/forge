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
import { interfaceContractsOf } from '../interface-contracts.js';
import { heldInterface } from '../interface-service.js';
import { readInterfaces } from '../interface-store.js';
import { lockKeys, projectsWhere } from '../store.js';
import { compareVersions, parseVersion, SCHEME_SHAPE, type Versioning } from './naming.js';
import { versionsOf } from './store.js';
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

type Resolved = {
  provider: { id: string; slug: string };
  contractSlug: string;
};

// A wait names a contract its issue's project publishes (written first, inside it) or consumes, at a
// version in the provider's own scheme, once per contract per live wait; a finished issue waits on nothing.
async function addRefusals(t: WaitTarget): Promise<ContractWaitRefusal[] | Resolved> {
  if ((ISSUE_TERMINAL_STATUSES as readonly string[]).includes(t.issue.status)) {
    return [
      {
        code: 'CONTRACT_WAIT_ISSUE_FINISHED',
        path: '',
        detail: `the issue is ${t.issue.status}; a finished issue is dispatched no more, so it waits on no contract version.`,
      },
    ];
  }
  const own = (await interfaceContractsOf(t.issue.projectId)) ?? { publishes: [], consumes: [] };
  const known = [...own.publishes, ...own.consumes];
  const [providerSlug, contractSlug] = t.contract.split('/') as [string, string];
  const [provider] = known.includes(t.contract)
    ? await projectsWhere(db, { slugs: [providerSlug] })
    : [];
  if (!provider) {
    return [
      {
        code: 'CONTRACT_WAIT_CONTRACT_UNKNOWN',
        path: '/contract',
        detail: `${t.contract} is neither published nor consumed by this project's interface (it names ${known.join(', ') || 'no contract'}); a wait names <provider slug>/<contract slug> as that interface lists it.`,
      },
    ];
  }
  const versioning = await versioningOf(db, provider.id);
  if (!versioning || !parseVersion(versioning, t.minVersion)) {
    return [
      {
        code: 'CONTRACT_WAIT_VERSION_NOT_IN_SCHEME',
        path: '/minVersion',
        detail: versioning
          ? `"${t.minVersion}" is not a ${versioning} version; ${provider.slug} names its versions ${SCHEME_SHAPE[versioning]}.`
          : `${provider.slug} declares no versioning scheme, so "${t.minVersion}" cannot be compared with any version it records.`,
      },
    ];
  }
  return { provider: { id: provider.id, slug: provider.slug }, contractSlug };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; refusals: ContractWaitRefusal[] };

export async function addContractWait(
  t: WaitTarget & { reason: string | null; userId: string },
): Promise<Outcome<ContractWaitRow>> {
  const resolved = await addRefusals(t);
  if (Array.isArray(resolved)) return { ok: false, refusals: resolved };
  return db.transaction(async (tx): Promise<Outcome<ContractWaitRow>> => {
    await lockKeys(tx, [`contract:${resolved.provider.id}/${resolved.contractSlug}`]);
    const held = await liveWaitOn(tx, {
      issueId: t.issue.id,
      providerProjectId: resolved.provider.id,
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
      providerProjectId: resolved.provider.id,
      contractSlug: resolved.contractSlug,
      minVersion: t.minVersion,
      reason: t.reason,
      createdBy: t.userId,
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
