import type { AgentReportRefusalCode } from '@forge/contracts/agent-reports';
import type { Refusal } from '../lib/refusal.js';

const CODE: AgentReportRefusalCode = 'AGENT_REPORT_PROMOTED';

// cm:guard ISS-93: a promoted report stays reviewed and keeps its one route, the feedback item it
// became; un-reviewing it or curating it into an issue is AGENT_REPORT_PROMOTED naming that item,
// one refusal per promoted report in the batch, and nothing in the batch is written
export function promotedRefusals(
  promoted: readonly { id: string; seq: number }[],
  reviewed: boolean,
): Refusal[] {
  return promoted.map((p) => {
    const fb = `FB-${p.seq}`;
    return reviewed
      ? {
          code: CODE,
          path: '/linkedIssueId',
          detail: `agent report ${p.id} was promoted into ${fb}, which is its one route; triage ${fb} to route issue instead.`,
        }
      : {
          code: CODE,
          path: '/reviewed',
          detail: `agent report ${p.id} was promoted into ${fb}, which keeps it reviewed; it cannot be marked unreviewed.`,
        };
  });
}
