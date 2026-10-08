// What Needs you reads from the design context: each design's health, from the one workflow health
// read model. The composition root provides it at boot (`work-ports.ts`).

import type { ActorAgency } from '@forge/contracts/permissions';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
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
}

export interface DesignRepinGroup {
  flow: string;
  revision: number;
  ready: { flow: string; source: 'approved' | 'proposal' }[];
  approvedAt: string | null;
}

const slot = portSlot<DevelopmentPorts>('development', 'provideDevelopmentPorts');
export const provideDevelopmentPorts = slot.provide;
export const designHealthOf = slot.port('designHealthOf');
export const designRepinsOf = slot.port('designRepinsOf');
