// What Needs you and the Delivery overview read from later contexts: each design's health, from the
// one workflow health read model, the release approvals a release run asks, and the runs' standings.
// A reminder it sends reaches notifications through here, since notifications is a later context.
// The composition root provides it at boot (`work-ports.ts`).

import type { ActorAgency } from '@forge/contracts/permissions';
import type { RunStanding } from '@forge/contracts/run-standing';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { withObservedReads } from '../db/observed-reads.js';
import { withQueryLeg } from '../db/query-timing.js';
import type { NotificationType } from '../db/schema.js';
import type { ReleaseApprovalRow } from '../db/schema-release-ledger.js';
import { portSlot } from '../lib/port-slot.js';

/**
 * Runs one Needs you area as a named part of the request's `Server-Timing`, with the statements it
 * sends (`db/query-timing.ts:withQueryLeg`): reached through here so the attention read names its
 * areas without reaching one module more.
 */
export const timedArea = withQueryLeg;

/**
 * Runs a person's attention read, whose readings of what production serves may be ones observed a
 * moment ago and said so (`db/observed-reads.ts:withObservedReads`), reached through here as
 * {@link timedArea} is.
 */
export const observedAttention = withObservedReads;

/** The notice Needs you's upkeep sends a person about a decision that has aged. */
interface DecisionReminderInput {
  recipients: string[];
  projectId: string;
  type: NotificationType;
  title: string;
  body: string;
  dedupeKey: string;
}

interface DevelopmentPorts {
  designHealthOf: (
    viewer: { userId: string; agency: ActorAgency },
    projectId: string,
  ) => Promise<Map<string, WorkflowHealth>>;
  /** Each moved base whose pin-only dependents one act would clear (`design-repin-service.ts`). */
  designRepinsOf: (
    viewer: { userId: string; agency: ActorAgency },
    projectId: string,
  ) => Promise<{ canDecide: boolean; groups: DesignRepinGroup[] }>;
  /** The release approvals asked of these release runs (`release-batch/approvals.ts:approvalsOfRuns`). */
  releaseApprovalsOfRuns: (runIds: readonly string[]) => Promise<ReleaseApprovalRow[]>;
  /** The production deploy each release run waits on a person's confirm for (`release-batch/coolify-prod-gate.ts`, ISS-1096). */
  releaseConfirmsOfRuns: (
    runIds: readonly string[],
  ) => Promise<Map<string, { bindingId: string; requestedAt: string }>>;
  /** Every live run's standing and the recently finished ones (`runs/read.ts:listRunStanding`), and
   *  the version the next cut takes (`release-batch/draft-version.ts:nextDraftVersion`), as `viewer`. */
  deliveryRunsOf: (projectId: string, viewer: { userId: string } | null) => Promise<DeliveryRuns>;
  /** The accounts the project's master acts as, each serving box's checkout holder (`master-accounts.ts`). */
  masterAccountsOf: (projectId: string) => Promise<string[]>;
  /** Tell people a decision has aged (`notifications/index.ts:emitNotification`). */
  emitNotification: (input: DecisionReminderInput) => Promise<{ id: string; delivered: number }>;
}

export interface DeliveryRuns {
  live: RunStanding[];
  finished: RunStanding[];
  drafted: string | null;
}

export interface DesignRepinGroup {
  baseId: string;
  flow: string;
  title: string;
  revision: number;
  /** Each design the one act approves: at the revision read, the one it leaves approved, the pins that move. */
  ready: {
    workflowId: string;
    flow: string;
    source: 'approved' | 'proposal';
    revision: number;
    approves: number;
    pins: { workflow: string; from: number; to: number }[];
  }[];
  refused: number;
  approvedAt: string | null;
}

const slot = portSlot<DevelopmentPorts>('development', 'provideDevelopmentPorts');
export const provideDevelopmentPorts = slot.provide;
export const designHealthOf = slot.port('designHealthOf');
export const designRepinsOf = slot.port('designRepinsOf');
export const releaseApprovalsOfRuns = slot.port('releaseApprovalsOfRuns');
export const releaseConfirmsOfRuns = slot.port('releaseConfirmsOfRuns');
export const deliveryRunsOf = slot.port('deliveryRunsOf');
export const masterAccountsOf = slot.port('masterAccountsOf');
export const emitNotification = slot.port('emitNotification');
