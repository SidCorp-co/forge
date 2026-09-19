// ISS-764 — prompt assembly for the release_batch job.
// Pattern: buildSmokeCanaryPrompt (skills/smoke-verify.ts:429).
// Untrusted issue text is wrapped via markUntrusted (same as every state prompt).

import type { ReleaseModel, ReleaseStrategy } from '../db/schema.js';
import { markUntrusted } from '../prompt/sanitize.js';
import { defaultReleaseProcedure, RELEASE_BATCH_SKILL, type ReleasePlan } from './plan.js';

interface IssueSummary {
  id: string;
  displayId: string;
  title: string;
}

interface BuildReleaseBatchPromptArgs {
  runId: string;
  projectId: string;
  baseBranch: string;
  liveBranch: string;
  releaseModel: ReleaseModel;
  /** Non-null exactly under `promote`. The default procedure refuses what it has no default for. */
  releaseStrategy: ReleaseStrategy | null;
  issues: IssueSummary[];
  plan: ReleasePlan;
}

export function buildReleaseBatchPrompt(args: BuildReleaseBatchPromptArgs): string {
  const { runId, projectId, baseBranch, liveBranch, releaseModel, releaseStrategy, issues, plan } =
    args;
  const roster = issues
    .map((i) => `- ${i.displayId} — ${markUntrusted(i.title, { source: 'issue.title' })}`)
    .join('\n');
  const liveLine = releaseModel === 'promote' ? `\nliveBranch: ${liveBranch}` : '';
  const channelLines =
    plan.channels.length === 0
      ? 'deploy channels: none — cut the version and stop; a human deploys'
      : `deploy channels (${plan.channels.length}, work ALL of them):\n${plan.channels
          .map((c) => `- ${c.provider}${c.label ? ` [${c.label}]` : ''}`)
          .join('\n')}`;

  return `## Batch Release

projectId: ${projectId}
runId: ${runId}
releaseModel: ${releaseModel}
baseBranch: ${baseBranch}${liveLine}
${channelLines}

### Issues in this batch (${issues.length})
${roster}
${renderMethod()}${renderProcedure(plan, releaseModel, releaseStrategy)}
Start by reading the batch context: \`forge-runner api projects/${projectId}/release-batches/${runId}\`.
`;
}

/**
 * The one line that loads the method, off the SAME constant the job's
 * `skillName` carries.
 *
 * `skillName` named `release-flow` and nothing invoked it: the runner reads no
 * such column, and this prompt never mentioned it, so the field selected
 * nothing while reading like a designation (ISS-1042). The name reaching the
 * agent is what makes it true.
 */
function renderMethod(): string {
  return `
### Your method
Load it before the first step: run the \`${RELEASE_BATCH_SKILL}\` skill, then announce what you loaded with \`POST projects/{projectId}/release-batches/{runId}/method\`. \`finish\` refuses a run that announced none.

If the skill does not load, announce THAT — do not improvise a release out of this prompt. An announcement saying the method could not be loaded is a run a person can see; a release run with no method is not.
`;
}

/**
 * The project's own release ritual, verbatim. Operator-authored text, so it is
 * NOT wrapped as untrusted: an operator writing their release steps is giving
 * an instruction, which is the opposite of an issue title arriving from a
 * stranger.
 */
function renderProcedure(
  plan: ReleasePlan,
  releaseModel: ReleaseModel,
  releaseStrategy: ReleaseStrategy | null,
): string {
  const blocks: string[] = [
    plan.procedure
      ? `### This project's release procedure\n${plan.procedure}`
      : `### Release procedure (Forge default — this project declared none)\n${defaultReleaseProcedure(
          { releaseModel, releaseStrategy, channels: plan.channels },
        )}`,
  ];
  for (const channel of plan.channels) {
    if (!channel.instructions) continue;
    const named = channel.label ? `${channel.provider} [${channel.label}]` : channel.provider;
    blocks.push(`### Deploy channel notes (${named})\n${channel.instructions}`);
  }
  const probeUrls = plan.channels.flatMap((c) => c.verify?.probes.map((p) => p.url) ?? []);
  if (probeUrls.length > 0) {
    const urls = probeUrls.map((u) => `- ${u}`).join('\n');
    blocks.push(
      `### Proof (the server checks this, you do not)\nWhen you call \`finish\`, pass \`commit\` — the SHA you pushed. The server then reads these probes itself:\n${urls}\nIt goes green only when the live build CHANGED from what was serving before this batch started AND matches your \`commit\`. A healthy site still serving the old build is a RED, and \`finish\` will refuse. That refusal is not something to retry or work around: it means the deploy did not land.`,
    );
  }
  blocks.push(renderRepairForward(plan));
  return `\n${blocks.join('\n\n')}\n`;
}

function renderRepairForward(plan: ReleasePlan): string {
  const texts = plan.channels
    .map((c) => c.rollback)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const prose = texts.filter((r) => 'text' in r);
  const declared =
    prose.length > 0
      ? `\n\nThis project's declared way back, quoted for the human and NOT for you:\n\n${prose
          .map((r) => `> ${(r as { text: string }).text.replace(/\n/g, '\n> ')}`)
          .join('\n>\n')}`
      : texts.some((r) => r.kind === 'coolify-image')
        ? "\n\nThis project's declared way back is a Coolify image restore, which a person performs from the integration screen. It is not yours."
        : '';
  return `### If the deploy comes up dead
REPAIR FORWARD, and never roll back. You may push a fix and deploy again. You may NOT \`git revert\`, \`reset --hard\` or force-push a shared branch, and you may NOT restore an earlier build — not by hand, not through Coolify, not by redeploying an older tag. From inside this session you cannot tell an outage you caused from one that was already there, and undoing reviewed work does not end an outage that survives it.

Where you cannot repair forward inside this run: \`abort\` with the reason, and comment on each issue with what failed and what state production is in. Nothing closes. Rolling back is a human decision and this is how you hand it to one.${declared}`;
}
