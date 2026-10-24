// What Needs you and the Delivery overview read from later contexts: each design's health, from the
// one workflow health read model, the release approvals a release run asks, and the runs' standings.
// The composition root provides it at boot (`work-ports.ts`).

import type { ActorAgency } from '@forge/contracts/permissions';
import type { RunStanding } from '@forge/contracts/run-standing';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import type { ReleaseApprovalRow } from '../db/schema-release-ledger.js';
import { portSlot } from '../lib/port-slot.js';

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
  /** Every live run's standing and the recently finished ones (`runs/read.ts:listRunStanding`), and
   *  the version the next cut takes (`release-batch/draft-version.ts:nextDraftVersion`), as `viewer`. */
  deliveryRunsOf: (projectId: string, viewer: { userId: string } | null) => Promise<DeliveryRuns>;
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
export const deliveryRunsOf = slot.port('deliveryRunsOf');
