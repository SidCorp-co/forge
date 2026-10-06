import type { WaitTargetInput, WaitTargetOutcome } from '../../lib/contract-versions.js';
import { parseVersion, SCHEME_SHAPE, type Versioning } from './naming.js';
import { dueAtOf } from './wait-due.js';

/** What the waiting project's interface and the named provider read, for one wait's check. */
export interface WaitTargetFacts {
  /** The contracts the waiting project's interface publishes and consumes. */
  known: readonly string[];
  /** The provider the contract names, read only when the interface names the contract. */
  provider: { id: string; slug: string } | null;
  versioning: Versioning | null;
}

// A wait names a contract its issue's project publishes (written first, inside it) or consumes, at a
// version in the provider's own scheme, by a deadline still ahead.
// The REST door and a breakdown item are checked by this one rule (requirement-to-delivery `breakdown`).
export function waitTargetOf(
  t: WaitTargetInput,
  facts: WaitTargetFacts,
  now: Date,
): WaitTargetOutcome {
  const due = dueAtOf(t.dueAt, now);
  if (!due.ok) return { ok: false, refusals: [due.refusal] };
  const { provider, versioning } = facts;
  if (!facts.known.includes(t.contract) || !provider) {
    return {
      ok: false,
      refusals: [
        {
          code: 'CONTRACT_WAIT_CONTRACT_UNKNOWN',
          path: '/contract',
          detail: `${t.contract} is neither published nor consumed by this project's interface (it names ${facts.known.join(', ') || 'no contract'}); a wait names <provider slug>/<contract slug> as that interface lists it.`,
        },
      ],
    };
  }
  if (!versioning || !parseVersion(versioning, t.minVersion)) {
    return {
      ok: false,
      refusals: [
        {
          code: 'CONTRACT_WAIT_VERSION_NOT_IN_SCHEME',
          path: '/minVersion',
          detail: versioning
            ? `"${t.minVersion}" is not a ${versioning} version; ${provider.slug} names its versions ${SCHEME_SHAPE[versioning]}.`
            : `${provider.slug} declares no versioning scheme, so "${t.minVersion}" cannot be compared with any version it records.`,
        },
      ],
    };
  }
  return {
    ok: true,
    value: {
      contract: t.contract,
      providerProjectId: provider.id,
      providerSlug: provider.slug,
      contractSlug: t.contract.split('/')[1] as string,
      minVersion: t.minVersion,
      dueAt: due.value,
    },
  };
}
