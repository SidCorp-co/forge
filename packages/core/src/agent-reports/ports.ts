// What agent reports need from the design context, handed in by the process entry at boot: a module
// imports only its own context or one before it (ADR 0008). Read only inside a call.

import type { AgentReportFeedbackLink } from '@forge/contracts/agent-reports';

interface AgentReportsPorts {
  /** The feedback item each report was triaged into, as the feedback domain shows it. */
  reportLinksOf(
    projectId: string,
    ids: readonly string[],
  ): Promise<Map<string, AgentReportFeedbackLink>>;
}

let provided: AgentReportsPorts | null = null;

export function provideAgentReportsPorts(ports: AgentReportsPorts): void {
  provided = ports;
}

export function agentReportsPorts(): AgentReportsPorts {
  if (!provided) {
    throw new Error(
      'agent-reports: no ports were provided, so a report cannot show the feedback it was triaged into; the process entry calls provideAgentReportsPorts before it serves',
    );
  }
  return provided;
}
