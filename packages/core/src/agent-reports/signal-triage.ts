import type { TriageAgentReportRequest } from '@forge/contracts/agent-reports';
import { eq, inArray, type SQL } from 'drizzle-orm';
import { agentReports } from '../db/schema.js';
import type { IssueChannel } from './file.js';
import { noWritableProjectRefusal, signalTriageRefusal } from './rules.js';
import { type ReportActor, type TriageOutcome, triageReports } from './triage.js';

export interface SignalTriage {
  signalKey: string;
  scope: 'project' | 'all';
  projectId: string | null;
  act: TriageAgentReportRequest;
  actor: ReportActor;
  channel: IssueChannel;
  linkIssue: { id: string; key: string } | null;
}

/** What each door answers for its own caller: may it write this project, which projects may it write. */
export interface SignalTriageDoor {
  requireWrite(projectId: string): Promise<void>;
  writableProjects(): Promise<string[]>;
}

/** Bulk triage of every report sharing one signalKey, the same act from REST and MCP. */
export async function triageBySignal(
  t: SignalTriage,
  door: SignalTriageDoor,
): Promise<TriageOutcome> {
  const refusal = signalTriageRefusal(t);
  if (refusal) return { ok: false, refusals: [refusal] };
  let reach: SQL;
  if (t.scope === 'project' && t.projectId) {
    await door.requireWrite(t.projectId);
    reach = eq(agentReports.projectId, t.projectId);
  } else {
    const writable = await door.writableProjects();
    if (writable.length === 0)
      return { ok: false, refusals: [noWritableProjectRefusal(t.signalKey)] };
    reach = inArray(agentReports.projectId, writable);
  }
  return triageReports({
    scope: [reach, eq(agentReports.signalKey, t.signalKey)],
    bulk: true,
    act: t.act,
    actor: t.actor,
    channel: t.channel,
    linkIssue: t.linkIssue,
  });
}
