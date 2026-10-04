import { AGENT_REPORT_LIMITS, type AgentReportSeverity } from '@forge/contracts/agent-reports';
import type { Tx } from '../db/client.js';
import type { IssuePriority, issueCreationChannels } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { insertIssueRow } from '../issues/create-service.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';

export type IssueChannel = (typeof issueCreationChannels)[number];

interface FiledReport {
  id: string;
  projectId: string;
  summary: string;
  detail: string | null;
  suggestion: string | null;
  kind: string;
  severity: AgentReportSeverity;
  target: string;
  targetRef: string | null;
}

const PRIORITY: Record<AgentReportSeverity, IssuePriority> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

const RANK: Record<AgentReportSeverity, number> = { low: 0, medium: 1, high: 2 };

function evidenceOf(r: FiledReport): string {
  const about = `${r.kind}, ${r.severity}, ${r.target}${r.targetRef ? ` ${r.targetRef}` : ''}`;
  return [
    `Agent report ${r.id} (${about}): ${r.summary}`,
    r.detail,
    r.suggestion ? `Suggested: ${r.suggestion}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// cm:why design automation rev 1 (step file): filing creates the issue at draft, in the reports'
// project, carrying the reports as its evidence, inside the transaction that sets them filed, so a
// filed report never points at an issue that was not written
export async function fileIssueIn(
  tx: Tx,
  reports: readonly FiledReport[],
  ask: { title?: string | undefined; description?: string | undefined },
  actor: { userId: string; agency: ActorAgency },
  channel: IssueChannel,
): Promise<{ id: string; key: string; created: true }> {
  const [first] = reports;
  if (!first) throw new Error('fileIssueIn: no report to file');
  const top = reports.reduce((a, r) => (RANK[r.severity] > RANK[a.severity] ? r : a), first);
  const issue = await insertIssueRow(
    tx,
    {
      projectId: first.projectId,
      title: ask.title ?? first.summary.slice(0, AGENT_REPORT_LIMITS.title),
      description: ask.description ?? reports.map(evidenceOf).join('\n\n---\n\n'),
      descriptionFormat: 'markdown',
      status: 'draft',
      priority: PRIORITY[top.severity],
      category: reports.some((r) => r.kind === 'bug') ? 'bug' : 'feature',
      createdById: actor.userId,
      createdByDeviceId: null,
      createdVia: channel,
    },
    { actor: { type: 'user', id: actor.userId, agency: actor.agency } },
  );
  const prefix = await activeIssuePrefix(first.projectId);
  return { id: issue.id, key: formatIssueRef(prefix, issue.issSeq), created: true };
}
