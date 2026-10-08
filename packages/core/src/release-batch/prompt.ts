// ISS-764 — prompt assembly for the release_batch job.
// Untrusted issue text is wrapped via markUntrusted (same as every state prompt).

import { chainLiveBranch, type ReleaseChain } from '../projects/release-chain.js';
import { markUntrusted } from '../prompt/sanitize.js';
import type { CarriedRecord } from './carried.js';
import { RELEASE_BATCH_SKILL, RELEASE_BATCH_TOOL, type ReleasePlan } from './plan.js';

interface IssueSummary {
  id: string;
  displayId: string;
  title: string;
}

interface BuildReleaseBatchPromptArgs {
  runId: string;
  projectId: string;
  /** `null` where the project declares none, which is a fact about the project and not a refusal. */
  baseBranch: string | null;
  releaseChain: ReleaseChain;
  issues: IssueSummary[];
  plan: ReleasePlan;
  /** False where no box eligible to release carries the declared label. */
  releaseRunnerPreferenceMet: boolean;
  carried?: CarriedRecord | null | undefined;
}

export function buildReleaseBatchPrompt(args: BuildReleaseBatchPromptArgs): string {
  const { runId, projectId, baseBranch, releaseChain, issues, plan } = args;
  const roster = issues
    .map((i) => `- ${i.displayId} — ${markUntrusted(i.title, { source: 'issue.title' })}`)
    .join('\n');
  const baseLine = baseBranch ? `\nbaseBranch: ${baseBranch}` : '';
  const liveBranch = chainLiveBranch(releaseChain);
  const liveLine = liveBranch ? `\nliveBranch: ${liveBranch}` : '';
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
      ? 'deploy channels: none declared to Forge'
      : `deploy channels (${plan.channels.length}, work ALL of them):\n${plan.channels
          .map((c) => `- ${c.provider}${c.label ? ` [${c.label}]` : ''}`)
          .join('\n')}`;

  return `## Batch Release

projectId: ${projectId}
runId: ${runId}
releaseChain: ${releaseChain.length === 0 ? 'empty — this project ships nothing' : releaseChain.map((e) => (e.from ? `${e.from} → ${e.branch}` : e.branch)).join(', then ')}${baseLine}${liveLine}${runnerLine}
${channelLines}

### Issues in this batch (${issues.length})
${roster}
${renderCarried(args.carried ?? null)}${renderReach(runId)}${renderMethod()}${renderProcedure(plan)}
Start by reading the batch context: \`${RELEASE_BATCH_TOOL}\` action \`get\` with runId \`${runId}\`.
`;
}

function renderCarried(carried: CarriedRecord | null): string {
  if (!carried) return '';
  if (carried.kind !== 'read') {
    return `\n### What this release carries beyond its roster\nNot read: ${carried.why}.\n`;
  }
  const decided = [...carried.issues, ...carried.cutBelow].map(
    (i) =>
      `- ${i.displayId} (at \`${i.status}\`, landing ${i.landing.slice(0, 12)}) — \`${i.decision}\`${i.why ? `: ${markUntrusted(i.why, { source: 'release.decision' })}` : ''}`,
  );
  return `
### The cut
Promote exactly \`${carried.cut}\` from \`${carried.start}\` onto \`${carried.live}\` — not the branch head, which may have moved since this batch was cut. Everything that commit carries was named when the batch opened, and nothing else was.
${decided.length > 0 ? `\nIssues this range carries off the roster, each with the decision recorded for it:\n${decided.join('\n')}\n` : ''}`;
}

/**
 * Every call this job makes to Forge goes through one tool, on the credential
 * its pane was opened with — the one \`forge_coolify_deploy\` deploys on. A run
 * that cannot reach it cannot record a release, so it is told to stop before
 * the release rather than discover that at \`finish\` (ISS-1211).
 */
function renderReach(runId: string): string {
  return `
### How you reach Forge
Every call below goes through the \`${RELEASE_BATCH_TOOL}\` MCP tool with runId \`${runId}\`: \`get\` reads the batch, \`method\` announces your method, \`look\` has Forge read the live deployment and keep what it saw, \`finish\` records the release, \`abort\` gives the batch back. It runs on the credential this session was started with, the same one a deploy through Forge uses.

If \`${RELEASE_BATCH_TOOL}\` is not in your tool list, or refuses your first call, STOP before you touch any branch, tag or deployment: nothing you did could be recorded. End the turn saying which of the two happened and the refusal's text. Do not look for another credential on this machine.
`;
}

/**
 * The line that points at the method, off the SAME constant the job's `skillName` carries: the
 * name reaching the agent is what makes the field true (ISS-1042). It points; it does not gate.
 */
function renderMethod(): string {
  return `
### Your method
Load it if this session has it: run the \`${RELEASE_BATCH_SKILL}\` skill, then announce what you loaded with \`${RELEASE_BATCH_TOOL}\` action \`method\` (\`skill\`, \`loaded\`).

If it will not load, announce THAT — \`loaded: false\` with a detail saying why — and carry on under the release procedure below, which is this project's own method. \`finish\` does not read the announcement and does not refuse a run that made none. What does depend on it: a deploy through \`forge_coolify_deploy\` is refused until this run has recorded SOMETHING through \`${RELEASE_BATCH_TOOL}\`, because until then nothing shows the credential this session holds can record what the deploy did.
`;
}

/**
 * The project's own release ritual, verbatim. Operator-authored text, so it is
 * NOT wrapped as untrusted: an operator writing their release steps is giving
 * an instruction, which is the opposite of an issue title arriving from a
 * stranger.
 * Where the project declares none, Forge says so and names where the method is instead (ISS-1276).
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
  const probed = plan.channels.filter((c) => c.verify !== null);
  if (probed.length > 0) {
    blocks.push(renderProof(probed, plan.channels.length - probed.length));
  } else if (plan.channels.length > 0) {
    blocks.push(UNVERIFIED_PROOF);
  }
  blocks.push(renderRepairForward(plan));
  return `\n${blocks.join('\n\n')}\n`;
}

/**
 * The agent decides when Forge looks and a finish closes on what Forge kept (ISS-1282). Nothing
 * here gives it a clock to race: it looks when it judges the deploy has landed, as often as it likes.
 */
function renderProof(probed: ReleasePlan['channels'], unprobed: number): string {
  const probes = probed
    .flatMap((c) => (c.verify?.probes ?? []).map((p) => `- ${p.url}`))
    .join('\n');
  const unread =
    unprobed === 0
      ? ''
      : `\n\n${unprobed} more live deploy ${unprobed === 1 ? 'binding declares' : 'bindings declare'} no probe, so nothing reads ${unprobed === 1 ? 'it' : 'them'}: \`look\` names ${unprobed === 1 ? 'it' : 'them'} as \`unread\`, and every issue the release closes carries a note saying so. Check ${unprobed === 1 ? 'it' : 'them'} yourself and say how in what you record.`;
  return `### Proof (Forge reads, you decide when)
Once the deploy is made, call \`${RELEASE_BATCH_TOOL}\` action \`look\` with \`commit\`, the SHA you pushed. Forge reads these probes itself and keeps what each said, with the time:
${probes}

You decide when to look and how often; no clock is running. Each answer carries \`judgement\`: whether a \`finish\` naming that commit would close the roster on the readings kept so far, and if not, why (a build still unchanged, a fleet that disagrees, too few consecutive readings agreeing, a reading too old). A deploy still coming up is a reason to look again later, not a failure. Call \`finish\` with the same \`commit\` once \`judgement.closable\` is true: it answers at once with the attempt at \`accepted\` and closes the roster on the kept readings and on nothing you say, so a \`finish\` before them is refused RELEASE_NOT_VERIFIED, closes nothing, and says what is missing. A healthy site still serving the old build is a RED, and nothing you can pass to \`finish\` works around it. Read the outcome with \`${RELEASE_BATCH_TOOL}\` action \`state\`: \`finish.state\` ends at \`finished\` or \`failed\`, and \`readings\` lists what was kept. Where the deploy will not land inside this run, the next section says what to do.${unread}`;
}

const UNVERIFIED_PROOF = `### Proof (this project declares none)
No live deploy binding on this project declares a verify probe, so there is nothing for \`look\` to read and it is refused: \`finish\` closes the roster on your call alone, and every issue it closes carries a note that this release was NOT verified. That makes your own check the only one there is. Call \`finish\` only once you have seen the deploy come up serving what you pushed, pass \`commit\` — the SHA you pushed — so the record names it, and say in what you record how you saw it. Read the outcome with \`${RELEASE_BATCH_TOOL}\` action \`state\`: \`finish.verification\` reads \`unverified\`.`;

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
