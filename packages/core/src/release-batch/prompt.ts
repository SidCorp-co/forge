// ISS-764 — prompt assembly for the release_batch job.
// Pattern: buildSmokeCanaryPrompt (skills/smoke-verify.ts:429).
// Untrusted issue text is wrapped via markUntrusted (same as every state prompt).

import { markUntrusted } from '../prompt/sanitize.js';
import { DEFAULT_RELEASE_PROCEDURE, type ReleasePlan } from './plan.js';

interface IssueSummary {
  id: string;
  displayId: string;
  title: string;
}

interface BuildReleaseBatchPromptArgs {
  runId: string;
  projectId: string;
  baseBranch: string;
  productionBranch: string;
  issues: IssueSummary[];
  plan: ReleasePlan;
}

export function buildReleaseBatchPrompt(args: BuildReleaseBatchPromptArgs): string {
  const { runId, projectId, baseBranch, productionBranch, issues, plan } = args;
  const roster = issues
    .map((i) => `- ${i.displayId} — ${markUntrusted(i.title, { source: 'issue.title' })}`)
    .join('\n');

  return `## Batch Release

projectId: ${projectId}
runId: ${runId}
baseBranch: ${baseBranch}
productionBranch: ${productionBranch}
deploy channel: ${plan.provider ?? 'none — cut the version and stop; a human deploys'}

### Issues in this batch (${issues.length})
${roster}
${renderProcedure(plan)}
Start by calling \`forge_release_batch get { runId: "${runId}" }\` to load the batch context.
`;
}

/**
 * The project's own release ritual, verbatim. Operator-authored text, so it is
 * NOT wrapped as untrusted: an operator writing their release steps is giving
 * an instruction, which is the opposite of an issue title arriving from a
 * stranger.
 */
// cm:guard the heading must say WHICH procedure the agent got. "Forge default" vs "this project's" is the difference between a step it may adapt and a step an operator wrote on purpose, and the agent has no other way to tell.
function renderProcedure(plan: ReleasePlan): string {
  const blocks: string[] = [
    plan.procedure
      ? `### This project's release procedure\n${plan.procedure}`
      : `### Release procedure (Forge default — this project declared none)\n${DEFAULT_RELEASE_PROCEDURE}`,
  ];
  if (plan.instructions) {
    blocks.push(`### Deploy channel notes (${plan.provider})\n${plan.instructions}`);
  }
  if (plan.verify) {
    const urls = plan.verify.probes.map((p) => `- ${p.url}`).join('\n');
    blocks.push(
      `### Proof (the server checks this, you do not)\nWhen you call \`finish\`, pass \`commit\` — the SHA you pushed to the production branch. The server then reads these probes itself:\n${urls}\nIt goes green only when the live build CHANGED from what was serving before this batch started AND matches your \`commit\`. A healthy site still serving the old build is a RED, and \`finish\` will refuse. That refusal is not something to retry or work around: it means the deploy did not land.`,
    );
  }
  if (plan.rollback) {
    blocks.push(
      `### If the deploy comes up dead\n${plan.rollback}\n\nRoll back AT MOST ONCE, and only when the deploy replaced a working build with a broken one. If the deploy never came up at all, the previous build is still serving — do nothing and abort. A rollback always ends in \`abort\`, never \`finish\`: nothing shipped.`,
    );
  }
  return `\n${blocks.join('\n\n')}\n`;
}
