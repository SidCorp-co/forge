import type { AgentReportRefusalCode } from '@forge/contracts/agent-reports';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentReports } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { Refusal } from '../lib/refusal.js';

// ISS-113: a filed report has exactly one target, so the issue it was filed into is not deleted out
// from under it. Agent reports are retired (REQ-47 BC-8) and read-only until a later migration drops
// them, so no reopen frees the issue: it is dropped instead, which keeps it and its evidence
export async function issueDeleteRefusal(issue: {
  id: string;
  projectId: string;
  issSeq: number;
}): Promise<Refusal | null> {
  const rows = await db
    .select({ id: agentReports.id })
    .from(agentReports)
    .where(eq(agentReports.linkedIssueId, issue.id))
    .orderBy(asc(agentReports.createdAt));
  if (rows.length === 0) return null;
  const key = formatIssueRef(await activeIssuePrefix(issue.projectId), issue.issSeq);
  const code: AgentReportRefusalCode = 'AGENT_REPORT_FILED_INTO_ISSUE';
  return {
    code,
    path: '',
    detail: `${key} carries ${rows.length} filed agent report(s) (${rows.map((r) => r.id).join(', ')}); agent reports are retired and read-only until they are dropped, so deleting ${key} would leave each with no target. Move ${key} to dropped instead.`,
  };
}
