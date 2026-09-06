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
Start by reading the batch context: \`forge-runner api projects/${projectId}/release-batches/${runId}\`.
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
  // cm:guard every branch must EMIT, the final else included. Silence is not an instruction: an agent told only that the deploy is dead will invent a way back, and from inside one session an outage that predates the release is indistinguishable from one it caused. ISS-897 rule 2 makes no-declaration mean ABORT; ISS-925 makes prose on a coolify binding mean ABORT too, and neither is discoverable by an agent the prompt does not tell.
  if (plan.rollback?.kind === 'manual') {
    blocks.push(
      `### If the deploy comes up dead\n${plan.rollback.text}\n\nRoll back AT MOST ONCE, and only when the deploy replaced a working build with a broken one. If the deploy never came up at all, the previous build is still serving — do nothing and abort. A rollback always ends in \`abort\`, never \`finish\`: nothing shipped.`,
    );
  } else if (plan.rollback?.kind === 'coolify-image') {
    blocks.push(
      '### If the deploy comes up dead\nForge performs this rollback — do NOT improvise one and do NOT touch Coolify by hand. Read the images first with `forge_coolify_deploy action=rollback-images`, then call `forge_coolify_deploy action=rollback` with the `commit` (image tag) you picked. A tag Coolify no longer lists is refused by name; that refusal means the image is gone, not that you should pick the nearest one. Roll back AT MOST ONCE, and only when the deploy replaced a working build with a broken one. A rollback always ends in `abort`, never `finish`: nothing shipped.',
    );
  } else if (plan.rollback?.kind === 'unrepresentable') {
    blocks.push(
      `### If the deploy comes up dead\nThis project's Coolify binding declares its rollback as free text, which Forge no longer executes (ISS-925) — a paragraph is not a rollback, and nothing has verified this one is still true. ABORT, and comment on each issue with what failed, what state production is in, and that the binding still needs converting to \`{"mode":"coolify-image"}\`. Do NOT follow the text below yourself; it is quoted only so a human can convert it:\n\n> ${plan.rollback.text.replace(/\n/g, '\n> ')}`,
    );
  } else {
    blocks.push(
      '### If the deploy comes up dead\nThis project declares NO rollback, so there is no way back for you to take. ABORT, and comment on each issue with what failed and what state production is in. Do NOT improvise one — not a revert, not a reset, not a redeploy of an older build: you cannot tell an outage you caused from one that was already there, and undoing reviewed work does not end an outage that survives it. Reverting is a human decision. Every issue stays at `released`.',
    );
  }
  return `\n${blocks.join('\n\n')}\n`;
}
