import type { Tx } from '../db/client.js';
import { portSlot } from './port-slot.js';

/** One recorded version of a provider's contract. */
export interface ContractVersionFact {
  providerProjectId: string;
  contractSlug: string;
  version: string;
  approval: string;
  contractType: string;
  elements: string[] | null;
  artifactSha256: string | null;
  /** The elements this version's measured diff names a breaking change to (removed or changed). */
  breakingElements: string[];
}

/**
 * The contract versions work, design and messaging read but do not own. Ecosystem sits after them in
 * the context order, so they name what they need here and the composition root fills it at boot.
 */
export interface ContractVersionReads {
  /** Every version these providers recorded, of `contractSlugs` only when named, newest first. */
  versionsOf(
    executor: Tx,
    providerProjectIds: readonly string[],
    contractSlugs?: readonly string[],
  ): Promise<ContractVersionFact[]>;
  /** Each contract's current version, chosen as ecosystem chooses it (`contract/store.ts:currentOf`). */
  currentVersionsOf(
    executor: Tx,
    providerProjectIds: readonly string[],
  ): Promise<ContractVersionFact[]>;
  /** The stored artifact under each of these hashes. */
  artifactsOf(shas: readonly string[]): Promise<Map<string, string>>;
}

const slot = portSlot<ContractVersionReads>('contract versions', 'provideContractVersionReads');
export const provideContractVersionReads = slot.provide;
export const contractVersionReads = slot.get;
