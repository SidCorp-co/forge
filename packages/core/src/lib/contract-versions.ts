import type {
  ContractWaitTarget,
  ContractWaitTargetRefusal,
} from '@forge/contracts/contract-waits';
import type { Tx } from '../db/client.js';
import { portSlot } from './port-slot.js';

/** The transaction lock a contract's versions are recorded, approved and waited on under. */
export const contractLockKey = (providerProjectId: string, contractSlug: string) =>
  `contract:${providerProjectId}/${contractSlug}`;

/** A wait's own fields, for the project whose issue waits. */
export interface WaitTargetInput extends ContractWaitTarget {
  projectId: string;
}

/** What a wait's fields resolve to once no check refuses them. */
export interface WaitTargetResolved {
  contract: string;
  providerProjectId: string;
  providerSlug: string;
  contractSlug: string;
  minVersion: string;
  dueAt: Date | null;
}

export type WaitTargetOutcome =
  | { ok: true; value: WaitTargetResolved }
  | { ok: false; refusals: ContractWaitTargetRefusal[] };

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
 * The contract versions work, design and messaging read but do not own, and the check a wait on one
 * passes. Ecosystem sits after them in the context order, so they name what they need here and the
 * composition root fills it at boot.
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
  /** A wait's fields checked as every door that writes a wait checks them, read through `executor`
   *  (`ecosystem/contract/waits.ts:contractWaitTargetIn`). */
  waitTargetIn(executor: Tx, target: WaitTargetInput, now: Date): Promise<WaitTargetOutcome>;
}

const slot = portSlot<ContractVersionReads>('contract versions', 'provideContractVersionReads');
export const provideContractVersionReads = slot.provide;
export const contractVersionReads = slot.get;
