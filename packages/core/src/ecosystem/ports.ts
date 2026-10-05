import type { NotificationType } from '../db/schema.js';
import { portSlot } from '../lib/port-slot.js';

/** One bell notice an ecosystem write raises on a side's project. */
export interface EcosystemNotice {
  recipients: string[];
  projectId: string;
  type: Extract<
    NotificationType,
    | 'channel_document_published'
    | 'channel_thread_held'
    | 'channel_gate_pending'
    | 'contract_version_published'
  >;
  title: string;
  body: string;
  dedupeKey?: string;
  resolutionKey?: string;
}

/**
 * What ecosystem tells the world after a write commits: the bell (Conversations) and the masters'
 * wake (the WebSocket door). Both sit downstream of ecosystem, so ecosystem names what it needs and
 * the composition root fills it at boot.
 */
export interface EcosystemSignals {
  notify(notice: EcosystemNotice): Promise<unknown>;
  resolve(resolutionKey: string, outcome: string): Promise<unknown>;
  projectAdmins(projectIds: readonly string[]): Promise<Map<string, string[]>>;
  wakeForChannel(projectId: string): Promise<unknown>;
  wakeForBuild(projectId: string): Promise<unknown>;
}

const slot = portSlot<EcosystemSignals>('ecosystem', 'provideEcosystemSignals');
export const provideEcosystemSignals = slot.provide;
export const ecosystemSignals = slot.get;
