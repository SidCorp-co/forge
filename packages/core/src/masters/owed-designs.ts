import { type GuideSlug, guideCall } from '../guides/index.js';
import { agrees } from '../lib/plural.js';
import type { DesignApprovalOwed } from './ports.js';

/** A line names the guide that holds its method by slug, never restates it (REQ-23 BC-2). */
const method = (slug: GuideSlug) => `\`${guideCall(slug)}\``;

/** What a design or requirement revision returned to the master owes: its next revision. */
export function returnedLine(owed: {
  designs: readonly { workflowId: string; flow: string; revision: number }[];
  revisions: readonly { key: string; revision: number }[];
}): string {
  let line = '';
  const { designs, revisions } = owed;
  if (designs.length > 0) {
    const keys = designs.map((d) => `${d.flow} r${d.revision}, workflow ${d.workflowId}`);
    line += ` ${designs.length} returned design${agrees(designs.length, ' owes', 's owe')} a revision no issue carries (${keys.join('; ')}): read each return's reason (\`forge-runner api projects/<projectId>/workflows/<workflowId>/design\`), then get the next revision written and proposed in a declared run, or record why it waits; ${method('workflow-design')} is how a revision is written and proposed, and the forge-master skill's returned-work section is the master's part.`;
  }
  if (revisions.length > 0) {
    const keys = revisions.map((r) => `${r.key} r${r.revision}`);
    line += ` ${revisions.length} returned requirement revision${agrees(revisions.length, ' owes', 's owe')} a revise (${keys.join(', ')}): read each (\`forge-runner api projects/<projectId>/requirements/<key>\`, its revision's \`returnReason\`), then write and propose it again, or drop it; ${method('requirement-lifecycle')} is how, and the forge-master skill's returned-work section is the master's part.`;
  }
  return line;
}

/**
 * ISS-1158 (FB-586): a design proposed where the master decides designs is its own act, never a
 * person's, so the pass names it until it is approved or returned (`owedDesignApprovals`).
 */
export function approvalsLine(approvals: readonly DesignApprovalOwed[]): string {
  if (approvals.length === 0) return '';
  const keys = approvals.map((d) => `${d.flow} r${d.revision}, workflow ${d.workflowId}`);
  return ` ${approvals.length} proposed design${agrees(approvals.length, ' waits', 's wait')} on your approval (${keys.join('; ')}): this project is not strict and asks no person for it, so read each (\`forge-runner api projects/<projectId>/workflows/<workflowId>/design\`), judge it by the workflow approval checklist ${method('workflow-design')} names (Who approves, and what an approval is judged by), then approve it (\`forge-runner api projects/<projectId>/workflows/<workflowId>/design/decision -X POST -d '{"revision":<n>,"decision":"approve"}'\`) or return it with its \`reason\` (\`"decision":"return"\`).`;
}
