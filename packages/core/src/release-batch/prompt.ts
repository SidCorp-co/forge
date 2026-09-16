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

// cm:guard the live-branch line is printed only under `promote`, for the same reason
// `prompt/system.ts` prints it only there: a `publish` project's release moves no ref (pixelight
// publishes a theme), so naming one states a promotion nobody makes. The deploy channels are a LIST
// rather than one line — core returns the whole live set and never picks (ISS-1046).
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
// cm:edge lockstep -> packages/core/src/release-batch/service.ts — `insertAndEnqueueJob` stamps `skillName: RELEASE_BATCH_SKILL` from this same constant. Two literals is how the job comes to name one skill while the prompt asks for another, and nothing anywhere would say so.
// cm:guard CROSS-REPO coupling, so no `cm:edge` can hold it: the skill itself is `plugin/skills/release-flow` in github.com/SidCorp-co/forge-plugin (ISS-1521) and reaches a box through its plugin designation. Until that lands the invocation finds nothing, which is why the line below says what to do when it does not load rather than assuming it did.
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
// cm:guard the heading must say WHICH procedure the agent got. "Forge default" vs "this project's" is the difference between a step it may adapt and a step an operator wrote on purpose, and the agent has no other way to tell.
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
  // cm:guard ONE block per channel, each naming its own binding. Folding the set into one block is
  // how an agent handed two endpoints reads one set of instructions and deploys half the project.
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

/**
 * What to do when the deploy comes up dead — which is never a rollback.
 *
 * This block used to have four branches, one per rollback declaration, and
 * three of them told the agent to perform one. From inside a single session an
 * outage you caused and an outage that was already there read identically, and
 * a rollback answers both by deleting reviewed work while the outage survives
 * it — which is the rule `drive-rules.ts` has held the driver to since ISS-897
 * and which the release agent was exempt from for no reason anybody wrote down.
 *
 * The declaration is still QUOTED where the project has one, because a human
 * deciding to roll back wants to read it. It is quoted as a human's option and
 * never as this agent's step.
 */
// cm:guard the declared text must never appear under an instruction to follow it. `classifyRollback` keeps `manual` / `coolify-image` / `unrepresentable` apart for the operator routes and the settings screen, and quoting any of them here as a step is the substitution this block removed.
// cm:edge lockstep -> packages/core/src/integrations/coolify/health-gate.ts — the same rule on the other path. The gate stopped restoring the previous image in the same change, so an unhealthy deploy now pages on both routes rather than being answered automatically on one of them.
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
