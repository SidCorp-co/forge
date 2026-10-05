/**
 * What a provider's production serves, for the contract release gate (requirement-to-delivery
 * `provider-live`, `release-gate`, E4): the commit its production probe answers now, and whether that
 * commit carries the commit a contract version was recorded at. Read when asked and never stored; a
 * reading that cannot be taken answers why, and the gate refuses rather than assume the provider live.
 */

import type { LiveShortfall } from '@forge/contracts/contract-waits';
import { resolveSourceHost, SourceHostUnavailable } from '../integrations/source-host/index.js';
import { portSlot } from '../lib/port-slot.js';
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
  /** The roster's issues whose wait the provider's production does not serve (ecosystem, after release). */
  contractProviderShortfalls(issueIds: readonly string[]): Promise<LiveShortfall[]>;
}

const slot = portSlot<ReleaseBatchPorts>('release-batch', 'provideReleaseBatchPorts');
export const provideReleaseBatchPorts = slot.provide;
export const contractProviderShortfalls = slot.port('contractProviderShortfalls');
