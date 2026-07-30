// ISS-764 — prompt assembly for the release_batch job.
// Pattern: buildSmokeCanaryPrompt (skills/smoke-verify.ts:429).
// Untrusted issue text is wrapped via markUntrusted (same as every state prompt).

import { markUntrusted } from '../prompt/sanitize.js';

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
}

export function buildReleaseBatchPrompt(args: BuildReleaseBatchPromptArgs): string {
  const { runId, projectId, baseBranch, productionBranch, issues } = args;
  const roster = issues
    .map((i) => `- ${i.displayId} — ${markUntrusted(i.title, { source: 'issue.title' })}`)
    .join('\n');

  return `## Batch Release

projectId: ${projectId}
runId: ${runId}
baseBranch: ${baseBranch}
productionBranch: ${productionBranch}

### Issues in this batch (${issues.length})
${roster}

Start by calling \`forge_release_batch get { runId: "${runId}" }\` to load the batch context.
`;
}
