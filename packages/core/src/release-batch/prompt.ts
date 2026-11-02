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
Every call below is \`forge-runner api ${path}[/...]\`: \`${path}\` reads the batch, \`${path}/method -X POST\` announces your method, \`${path}/finish -X POST\` records the release, \`${path}/state\` reads its outcome, \`${path}/abort -X POST\` gives the batch back. It runs on the credential this session was started with. Right after you push the release commit, before you deploy it, \`forge-runner release range --project-id ${projectId} --run ${runId} --head <sha>\`, run in the checkout you cut the release in, reports what its commit range ships on the same credential: the release page reads what an admin must do from it, and Forge tags that commit \`v<version>\` on the source host, so the build you deploy can read its version.

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

If it will not load, announce THAT — \`loaded: false\` with a detail saying why — and carry on under the release procedure below, which is this project's own method. \`finish\` does not read the announcement and does not refuse a run that made none. What does depend on it: a deploy (\`POST /api/projects/:id/integrations/coolify/deploy\`) is refused until this run has recorded SOMETHING on its release batch, because until then nothing shows the credential this session holds can record what the deploy did.
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
  if (plan.channels.length > 0) blocks.push(RECORD_CLOSES);
  blocks.push(renderRepairForward(plan));
  return `\n${blocks.join('\n\n')}\n`;
}

const RECORD_CLOSES = `### Your finish is the release's record
Call \`finish\` once you have watched the deploy go live: your finish is the record of this release under the version it was cut with, and it closes the roster (owner ruling 2026-11-01). The server reads no probe, no deployment record and no provider report, and replays no kept probe. Pass \`commit\`, the SHA you pushed, as your evidence: it is kept, never compared. Read the outcome with \`state\`: \`finish.verification\` reads \`recorded\`. Never call \`finish\` for a deploy you did not see land.`;

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

Where you cannot repair forward inside this run: \`abort\` with the reason, and comment on each issue with what failed and what state production is in. The abort closes nothing, and its answer says where each issue now is. Rolling back is a human decision and this is how you hand it to one.

When what stopped you is a person's to fix (a credential this box lacks, an access grant, a decision), add \`"blocker":{"owes":"human","waitingFor":"<what they must do>"}\` to the abort: the roster stays at the gate held for that person, and no automatic release cuts it again until they act. When nothing is left to release because an earlier release already shipped the roster's work, add \`"shippedIn":{"version":"<that release>","evidence":"<the git command and its answer>"}\` instead: each issue is recorded as shipped there and closes, and one that cannot waits on its agent's shipped-in record, never on a person. Say what now carries this release's version outside Forge: \`"carried":[{"kind":"tag","name":"<the tag>"}]\`, one entry per pushed tag, release commit (\`commit\`), published artifact (\`artifact\`) or notice sent to people (\`notice\`), or \`"carried":[]\` when nothing of this release left the box. With nothing carried the next attempt at this roster wears the same version again; with anything carried it takes a new version and names what you listed. Left out, the next attempt is refused \`RELEASE_VERSION_UNDECIDED\` until somebody says.${declared}`;
}
