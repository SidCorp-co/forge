// What agent reports need from the design context, handed in by the process entry at boot: a module
// imports only its own context or one before it (ADR 0008). Read only inside a call.

import type { AgentReportFeedbackLink } from '@forge/contracts/agent-reports';
import { portSlot } from '../lib/port-slot.js';

interface AgentReportsPorts {
  /** The feedback item each report was triaged into, as the feedback domain shows it. */
  reportLinksOf(
    projectId: string,
    ids: readonly string[],
  ): Promise<Map<string, AgentReportFeedbackLink>>;
}

const slot = portSlot<AgentReportsPorts>('agent-reports', 'provideAgentReportsPorts');
export const provideAgentReportsPorts = slot.provide;
export const agentReportsPorts = slot.get;
