import type { NotificationType } from '../db/schema.js';

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

let provided: EcosystemSignals | null = null;

export function provideEcosystemSignals(signals: EcosystemSignals): void {
  provided = signals;
}

export function ecosystemSignals(): EcosystemSignals {
  if (!provided) {
    throw new Error(
      'ecosystem: no signals were provided, so a notice or a master wake cannot be sent; the process entry calls provideEcosystemSignals before it serves',
    );
  }
  return provided;
}
