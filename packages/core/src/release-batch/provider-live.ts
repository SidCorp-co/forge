/**
 * What a provider's production serves, for the contract release gate (requirement-to-delivery
 * `provider-live`, `release-gate`, E4): the commit its production probe answers now, and whether that
 * commit carries the commit a contract version was recorded at. Read when asked and never stored; a
 * reading that cannot be taken answers why, and the gate refuses rather than assume the provider live.
 */

import {
  CONTRACT_PROVIDER_NOT_LIVE,
  type LiveShortfall,
  notLiveSentence,
  type ProviderLiveGate,
} from '@forge/contracts/contract-waits';
import { resolveSourceHost, SourceHostUnavailable } from '../integrations/source-host/index.js';
import { portSlot } from '../lib/port-slot.js';
import { RefusalError } from '../lib/refusal.js';
import { carriageOf } from './carriage.js';
import { closeVerification, resolveReleasePlan } from './channel.js';
import { deploymentConfirms, readLiveCommit } from './verify.js';

export type Reading<T> = { ok: true; value: T } | { ok: false; why: string };

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function servedProductionCommit(projectId: string): Promise<Reading<string>> {
  try {
    const verification = closeVerification((await resolveReleasePlan(projectId)).channels);
    if (verification.kind !== 'probed') {
      return {
        ok: false,
        why: 'its production declares no source probe, so nothing reads which commit it serves',
      };
    }
    const commit = await readLiveCommit(verification.cfg);
    return commit
      ? { ok: true, value: commit }
      : { ok: false, why: 'its production probe answered no commit' };
  } catch (err) {
    return { ok: false, why: why(err) };
  }
}

/** Whether `served` holds `recordedAt`: the same commit, or one that descends from it. */
export async function servedCarries(
  projectId: string,
  recordedAt: string,
  served: string,
): Promise<Reading<boolean>> {
  if (deploymentConfirms(recordedAt, served)) return { ok: true, value: true };
  try {
    const carriage = await carriageOf(
      await resolveSourceHost(projectId, 'kernel'),
      recordedAt,
      served,
    );
    if (carriage.kind === 'unread') return { ok: false, why: carriage.why };
    return { ok: true, value: carriage.kind === 'descends' };
  } catch (err) {
    if (err instanceof SourceHostUnavailable) return { ok: false, why: err.message };
    throw err;
  }
}

interface ReleaseBatchPorts {
  /** The roster's waits the provider's production does not serve, and those the gate let through (ecosystem, after release). */
  contractProviderGate(issueIds: readonly string[]): Promise<ProviderLiveGate>;
}

const slot = portSlot<ReleaseBatchPorts>('release-batch', 'provideReleaseBatchPorts');
export const provideReleaseBatchPorts = slot.provide;
const contractProviderGate = slot.port('contractProviderGate');

/** What a release records of a gate it passed because the ecosystem turned it off. */
export type GateOffRecord = Pick<LiveShortfall, 'issue' | 'contract' | 'needed' | 'live'>[];

/** The refusal, once per held issue, pointed at it in the call's `issueIds`. */
export function providerNotLiveRefusal(
  issueIds: readonly string[],
  short: readonly LiveShortfall[],
): RefusalError {
  const byIssue = new Map<string, LiveShortfall[]>();
  for (const s of short) byIssue.set(s.issueId, [...(byIssue.get(s.issueId) ?? []), s]);
  return new RefusalError(
    [...byIssue].map(([issueId, own]) => {
      const at = issueIds.indexOf(issueId);
      return {
        code: CONTRACT_PROVIDER_NOT_LIVE,
        path: at >= 0 ? `/issueIds/${at}` : '/issueIds',
        detail: notLiveSentence(own),
      };
    }),
    'RELEASE_REFUSED',
  );
}

/**
 * The release gate every production release asks, a batch and a release recorded from evidence
 * alike (E4): a consumer's release waits for its provider to serve the contract version each of its
 * issues waits on. Where the ecosystem turned the gate off the release proceeds, and what it let
 * through is answered for the release to record as gate off.
 */
export async function askProviderLiveGate(issueIds: readonly string[]): Promise<GateOffRecord> {
  const gate = await contractProviderGate(issueIds);
  if (gate.shortfalls.length > 0) throw providerNotLiveRefusal(issueIds, gate.shortfalls);
  return gate.gateOff.map(({ issue, contract, needed, live }) => ({
    issue,
    contract,
    needed,
    live,
  }));
}
