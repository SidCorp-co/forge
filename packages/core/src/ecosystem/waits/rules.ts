import type { ContractWaitRefusal, ProviderLiveMode } from '@forge/contracts/contract-waits';
import { type PermissionFacts, permissionRefusal } from '../../permissions/index.js';
import {
  compareVersions,
  parseVersion,
  SCHEME_SHAPE,
  type Versioning,
} from '../contract/naming.js';

export type { ContractWaitRefusal } from '@forge/contracts/contract-waits';

export const writerRefusal = (facts: PermissionFacts, act: string): ContractWaitRefusal | null =>
  permissionRefusal(facts, 'project.write', act);

export interface RequestFacts {
  number: string;
  consumerId: string;
  providerId: string;
  contractSlug: string;
}

export interface WaitTarget {
  consumerId: string;
  ref: string;
  contractSlug: string;
  provider: { id: string; slug: string } | null;
  publication: { ecosystems: readonly string[] } | null;
  consumerEcosystems: readonly string[];
  versioning: Versioning | null;
  minVersion: string;
  duplicate: { id: string; minVersion: string } | null;
  requestNamed: string | null;
  request: RequestFacts | null;
}

function requestRefusal(t: WaitTarget, providerId: string): ContractWaitRefusal | null {
  if (!t.requestNamed) return null;
  const r = t.request;
  if (
    r &&
    r.consumerId === t.consumerId &&
    r.providerId === providerId &&
    r.contractSlug === t.contractSlug
  ) {
    return null;
  }
  return {
    code: 'CONTRACT_WAIT_REQUEST_MISMATCH',
    path: '/request',
    detail: r
      ? `${r.number} asks for another contract or comes from another project; a wait rides only on a change request this project sent about ${t.ref}.`
      : `${t.requestNamed} names no change request this project published; name the CR number its channel gave it.`,
  };
}

// cm:guard a wait names another project's published contract, shared in an ecosystem this project is
// active in, at a version in the provider's own scheme, once per contract per issue (E1)
export function addRefusals(t: WaitTarget): ContractWaitRefusal[] {
  if (!t.provider || !t.publication) {
    return [
      {
        code: 'CONTRACT_WAIT_CONTRACT_UNKNOWN',
        path: '/contract',
        detail: `${t.ref} names no contract a project publishes; a wait names <provider slug>/<publication slug> as the provider's interface declares it.`,
      },
    ];
  }
  if (t.provider.id === t.consumerId) {
    return [
      {
        code: 'CONTRACT_WAIT_OWN_CONTRACT',
        path: '/contract',
        detail: `${t.ref} is this project's own contract; an issue waits on the issue that ships it with a blocks edge, and on another project's contract with a wait.`,
      },
    ];
  }
  const out: ContractWaitRefusal[] = [];
  if (!t.publication.ecosystems.some((e) => t.consumerEcosystems.includes(e))) {
    out.push({
      code: 'CONTRACT_WAIT_NOT_SHARED',
      path: '/contract',
      detail: `${t.ref} is not published to an ecosystem this project is an active member of; a project waits only on a contract it could consume.`,
    });
  }
  if (!t.versioning || !parseVersion(t.versioning, t.minVersion)) {
    out.push({
      code: 'CONTRACT_WAIT_VERSION_NOT_IN_SCHEME',
      path: '/minVersion',
      detail: t.versioning
        ? `"${t.minVersion}" is not a ${t.versioning} version; ${t.provider.slug} names its versions ${SCHEME_SHAPE[t.versioning]}.`
        : `${t.provider.slug} declares no versioning scheme, so "${t.minVersion}" cannot be compared with anything it publishes.`,
    });
  }
  if (t.duplicate) {
    out.push({
      code: 'CONTRACT_WAIT_DUPLICATE',
      path: '/contract',
      detail: `this issue already waits on ${t.ref} >= ${t.duplicate.minVersion} (wait ${t.duplicate.id}); retract it first to wait on another version.`,
    });
  }
  const request = requestRefusal(t, t.provider.id);
  if (request) out.push(request);
  return out;
}

export function retractRefusal(wait: {
  id: string;
  retractedAt: Date | null;
}): ContractWaitRefusal | null {
  if (!wait.retractedAt) return null;
  return {
    code: 'CONTRACT_WAIT_RETRACTED',
    path: '/wait',
    detail: `wait ${wait.id} was retracted at ${wait.retractedAt.toISOString()}; a retracted wait stays as it was, and a new one is added instead.`,
  };
}

export function settlingVersion(
  versioning: Versioning,
  min: string,
  approvedNewestFirst: readonly string[],
): string | null {
  return approvedNewestFirst.find((v) => compareVersions(versioning, v, min) >= 0) ?? null;
}

// cm:guard a live wait that no approved version has settled holds its issue out of dispatch, read the same
// way by the admissible list's SQL (`gate.ts:waitUnsettledSql`) and by the run and claim doors
export const holdsDispatch = (w: { retractedAt: Date | null; settledAt: Date | null }): boolean =>
  w.retractedAt === null && w.settledAt === null;

export function unsettledDetail(w: {
  issue: string;
  contract: string;
  minVersion: string;
  current: string | null;
}): string {
  return `${w.issue} waits on ${w.contract} >= ${w.minVersion}, and its provider has published ${w.current ?? 'no version'}; it is dispatched once the provider approves a version at or above it.`;
}

export function providerLiveMode(
  modes: readonly (ProviderLiveMode | undefined)[],
): ProviderLiveMode {
  return modes.length > 0 && modes.every((m) => m === 'off') ? 'off' : 'required';
}

export interface LiveShortfall {
  issueId: string;
  issue: string;
  contract: string;
  needed: string;
  live: string | null;
}

// cm:guard kernel, zero tolerance: a consumer's production release ships past a wait only once the
// provider's production serves a version at or above it, unless the ecosystem turned that off (E4)
export function providerLiveShortfall(f: {
  issueId: string;
  issue: string;
  contract: string;
  minVersion: string;
  versioning: Versioning | null;
  live: string | null;
  mode: ProviderLiveMode;
}): LiveShortfall | null {
  if (f.mode === 'off') return null;
  if (f.live && f.versioning && compareVersions(f.versioning, f.live, f.minVersion) >= 0) {
    return null;
  }
  return {
    issueId: f.issueId,
    issue: f.issue,
    contract: f.contract,
    needed: f.minVersion,
    live: f.live,
  };
}

export function notLiveSentence(shortfalls: readonly LiveShortfall[]): string {
  const each = shortfalls
    .map(
      (s) =>
        `\`${s.issue}\` needs ${s.contract} >= ${s.needed}, and its provider's production serves ${s.live ?? 'no version Forge could read'}`,
    )
    .join('; ');
  return `A production release of this project waits for each provider to serve the contract version its issues wait on: ${each}. Release once the provider has, or take the issue out of this release; the ecosystem's steward can set releases.providerLive to "off" where this gate is not wanted.`;
}
