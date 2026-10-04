/** Who writes a provider's own interface and contract versions, and who set the commitments it makes. */

import { isDeepStrictEqual } from 'node:util';
import type { ActorAgency } from '../issues/actor-agency.js';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';
import type { EcosystemRefusal } from './refusals.js';

/** A provider's interface and contract versions are written by a holder of contracts.write on it. */
export const providerWriterRefusal = (facts: PermissionFacts, what: string): EcosystemRefusal | null =>
  permissionRefusal(facts, 'contracts.write', what);

export interface RevisionBy {
  revision: number;
  document: unknown;
  writtenBy: string;
  writtenAt: Date;
  agency: ActorAgency;
}

export interface CommitmentsSetter {
  userId: string;
  agency: ActorAgency;
  revision: number;
  at: string;
}

const commitmentsOf = (doc: unknown): unknown =>
  typeof doc === 'object' && doc !== null
    ? (doc as { commitments?: unknown }).commitments
    : undefined;

/** The revision that last changed the commitments: the oldest of the unbroken run, newest first, that holds them as they are now. */
export function commitmentsSetterOf(newestFirst: readonly RevisionBy[]): CommitmentsSetter | null {
  const [head] = newestFirst;
  if (!head) return null;
  const now = commitmentsOf(head.document);
  let setter = head;
  for (const r of newestFirst.slice(1)) {
    if (!isDeepStrictEqual(commitmentsOf(r.document), now)) break;
    setter = r;
  }
  return {
    userId: setter.writtenBy,
    agency: setter.agency,
    revision: setter.revision,
    at: setter.writtenAt.toISOString(),
  };
}

/** Moving commitments that are already set takes commitments.write; setting the first ones does not. */
export function commitmentsRefusal(
  facts: PermissionFacts,
  current: unknown,
  next: unknown,
): EcosystemRefusal | null {
  const was = commitmentsOf(current);
  if (was === undefined || isDeepStrictEqual(was, commitmentsOf(next))) return null;
  return permissionRefusal(facts, 'commitments.write', 'changing the commitments');
}
