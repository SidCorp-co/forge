// ISS-764 — prompt assembly for the release_batch job.
// Untrusted issue text is wrapped via markUntrusted (same as every state prompt).

import { markUntrusted } from '../lib/untrusted-text.js';
import { describeCrossings, type ReleasePath } from '../project-config/index.js';
import { RELEASE_BATCH_SKILL, type ReleasePlan, releaseBatchPath } from './plan.js';

interface IssueSummary {
  id: string;
  displayId: string;
  title: string;
}

interface BuildReleaseBatchPromptArgs {
  runId: string;
  projectId: string;
  /** `null` on a project with no git source, which is a fact about the project and not a refusal. */
  defaultBranch: string | null;
  path: ReleasePath;
  issues: IssueSummary[];
  plan: ReleasePlan;
  /** False where no box eligible to release carries the declared label. */
  releaseRunnerPreferenceMet: boolean;
}

export function buildReleaseBatchPrompt(args: BuildReleaseBatchPromptArgs): string {
  const { runId, projectId, defaultBranch, path, issues, plan } = args;
  const roster = issues
    .map((i) => `- ${i.displayId} — ${markUntrusted(i.title, { source: 'issue.title' })}`)
    .join('\n');
  const baseLine = defaultBranch ? `\ndefaultBranch: ${defaultBranch}` : '';
  const production = path.production
    ? `\nproduction: environment \`${path.production.name}\`${path.production.declaration.deploysFrom ? `, deploys from \`${path.production.declaration.deploysFrom}\`` : ''}`
    : '';
  // What was true when the batch was CUT, never where it ended up running: the
  // job is claimed after this string is built, and a box carrying the label can
  // come online in between. The box that took it is in the batch context.
  const runnerLine = plan.releaseRunnerLabel
    ? `\nrelease runner: this project prefers a box labelled \`${plan.releaseRunnerLabel}\`${
        args.releaseRunnerPreferenceMet
          ? ''
          : ' — no box eligible to release carried it when this batch was cut. Read `releaseRunner` in the batch context for the box this job was claimed on, and say in what you record whether the preference was honoured.'
      }`
    : '';
  const channelLines =
    plan.channels.length === 0
      ? 'deploy channel: none declared to Forge'
      : `deploy channel:\n${plan.channels
          .map((c) => `- ${c.provider}${c.label ? ` [${c.label}]` : ''}, binding ${c.bindingId}`)
          .join('\n')}`;

  return `## Batch Release

projectId: ${projectId}
runId: ${runId}
promotions: ${describeCrossings(path)}${baseLine}${production}${runnerLine}
${channelLines}

### Issues in this batch (${issues.length})
${roster}
${renderReach(projectId, runId)}${renderMethod()}${renderProcedure(plan)}
Start by reading the batch context: \`forge-runner api ${releaseBatchPath(projectId, runId)}\`.
`;
}

/**
 * Every call this job makes to Forge goes through one REST path, on the credential its pane was
 * opened with. A run that cannot reach it cannot record a release, so it is told to stop before the
 * release rather than discover that at `finish` (ISS-1211).
 */
function renderReach(projectId: string, runId: string): string {
  const path = releaseBatchPath(projectId, runId);
  return `
### How you reach Forge
Every call below is \`forge-runner api ${path}[/...]\`: \`${path}\` reads the batch, \`${path}/method -X POST\` announces your method, \`${path}/finish -X POST\` records the release, \`${path}/state\` reads its outcome, \`${path}/abort -X POST\` gives the batch back. It runs on the credential this session was started with.

If the first call is refused, STOP before you touch any branch, tag or deployment: nothing you did could be recorded. End the turn saying so, with the refusal's text. Do not look for another credential on this machine.
`;
}

/**
 * The line that points at the method, off the SAME constant the job's `skillName` carries.
 *
 * `skillName` named `release-flow` and nothing invoked it: the runner reads no such column, and this
 * prompt never mentioned it, so the field selected nothing while reading like a designation
 * (ISS-1042). The name reaching the agent is what makes it true. It points; it no longer gates
 * (ISS-1276) — the procedure above is the method, and this is a way of loading one shape of it.
 */
function renderMethod(): string {
  return `
### Your method
Load it if this session has it: run the \`${RELEASE_BATCH_SKILL}\` skill, then announce what you loaded with \`method\` (\`{"skill":"<name>","loaded":true}\`).

If it will not load, announce THAT — \`loaded: false\` with a detail saying why — and carry on under the release procedure below, which is this project's own method. \`finish\` does not read the announcement and does not refuse a run that made none. What does depend on it: a deploy through \`forge_coolify_deploy\` is refused until this run has recorded SOMETHING on its release batch, because until then nothing shows the credential this session holds can record what the deploy did.
`;
}

/**
 * The project's own release ritual, verbatim. Operator-authored text, so it is
 * NOT wrapped as untrusted: an operator writing their release steps is giving
 * an instruction, which is the opposite of an issue title arriving from a
 * stranger.
 *
 * ISS-1276 — where the project declares none, Forge says so and names where the method is instead.
 * It composed one until then, out of a registry of per-provider deploy steps exactly one provider
 * ever declared, refused the release for every provider that declared none, and threw the whole
 * composition away for every project that HAD declared a procedure.
 */
function renderProcedure(plan: ReleasePlan): string {
  const blocks: string[] = [
    plan.procedure
      ? `### This project's release procedure\n${plan.procedure}`
      : UNDECLARED_PROCEDURE,
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
      `### Proof (the server checks this, you do not)\nWhen you call \`finish\`, pass \`commit\` — the SHA you pushed. \`finish\` answers at once with the attempt at \`accepted\`; the server then reads these probes itself:\n${urls}\nIt goes green when the live build matches your \`commit\` — a finish naming no commit goes green only when the live build CHANGED from what was serving when this batch opened, and is refused where nothing was recorded serving then — and then closes the roster on its own. Read the verdict with \`state\`: \`finish.state\` ends at \`finished\` or \`failed\`, and a \`failed\` one carries its \`refusal\`. A healthy site still serving the old build is a RED: at that reading the deploy had not landed, and nothing you can pass to \`finish\` works around it. A \`failed\` attempt is not the end of the batch. Once the deploy has landed — it was still coming up when the window closed, or you repaired forward and deployed again — call \`finish\` again with the commit you last pushed, which starts a new attempt. Where it will not land inside this run, the next section says what to do.`,
    );
  } else if (plan.channels.length > 0) {
    blocks.push(UNVERIFIED_PROOF);
  }
  blocks.push(renderRepairForward(plan));
  return `\n${blocks.join('\n\n')}\n`;
}

const UNVERIFIED_PROOF = `### Proof (this project declares none)
The production environment declares no runtime probe identifying the source, so the server reads nothing when you call \`finish\`: it closes the roster on your call alone, and every issue it closes carries a note that this release was NOT verified. That makes your own check the only one there is. Call \`finish\` only once you have seen the deploy come up serving what you pushed, pass \`commit\` — the SHA you pushed — so the record names it, and say in what you record how you saw it. Read the outcome with \`state\`: \`finish.verification\` reads \`unverified\`.`;

const UNDECLARED_PROCEDURE = `### This project's release procedure
This project has declared none to Forge.
Forge writes no release steps of its own, for this project or for any other.
The method is where this project keeps it. Read it there:
- the repository you are releasing — its release and deploy scripts, its CI workflows, its branch and changelog conventions;
- the project's own configuration, which the batch context above carries;
- what this session already knows about this project.
Say in what you record which of those you read and what you took from each.`;

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

Where you cannot repair forward inside this run: \`abort\` with the reason, and comment on each issue with what failed and what state production is in. The abort closes nothing, and its answer says where each issue now is. Rolling back is a human decision and this is how you hand it to one.${declared}`;
}
