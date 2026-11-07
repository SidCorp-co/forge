// A deploy is sent once (ISS-1116). agenfold 0.207.0, 2026-11-07: the master deployed run 0d199511
// by hand at 13:46:42, Coolify ran deployment e8gws4o4o4ow0808o0gc04sg until 13:50:10, and the
// release_batch job for the same run deployed commit de7ccf81 again at 13:50:02. On a compose app a
// deploy removes the whole stack, so production went down twice. The door keys a deploy on run +
// binding + commit and answers a repeat with the deployment already sent, never a refusal (owner,
// 2026-11-05: teach the flow, don't block it). The record read is core's own (`sent-deploys.ts`),
// and the commit is the head of the branch the binding's environment deploys from, read on the
// project's source host as the door is called. An explicit redeploy still goes out, and says so.

import { type DeployCaller, type SentDeploy, sentDeploysOf } from '../integrations/deploy/index.js';
import { resolveSourceHost } from '../integrations/source-host/index.js';
import { userNames } from '../lib/people.js';
import { readDeployHolds } from '../pipeline/index.js';
import { bindingOf, environmentsOf, readProjectDocument } from '../project-config/index.js';

export type { DeployCaller };

/** The commit a deploy through this binding would build, or why it could not be read. */
export interface DeployCommit {
  commit: string | null;
  why: string | null;
}

/** A deploy the door did not send again, as the answer names it. */
export interface AlreadySent {
  integrationId: string;
  deploymentUuid: string | null;
  state: SentDeploy['state'];
  commit: string | null;
  runId: string | null;
  sentAt: string | null;
  sentBy: string | null;
  says: string;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : 'an unread commit');

/** The head of the branch the environment this binding deploys builds from, read on the host. */
export async function deployCommitOf(projectId: string, bindingId: string): Promise<DeployCommit> {
  const held = await readProjectDocument(projectId);
  const env = held ? environmentsOf(held.document).find((e) => bindingOf(e) === bindingId) : null;
  const source = held?.document.source;
  const branch =
    env?.declaration.deploysFrom ?? (source?.type === 'git' ? source.git.defaultBranch : null);
  if (!branch) return { commit: null, why: 'no branch is declared for this binding to deploy' };
  try {
    const host = await resolveSourceHost(projectId, 'kernel');
    return { commit: (await host.branchHead(branch)).toLowerCase(), why: null };
  } catch (err) {
    return {
      commit: null,
      why: `the head of \`${branch}\` could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The deploy already sent that answers this one, or null where it goes out. On the same run a
 * running or queued deploy answers it unless both commits are read and differ, and a succeeded one
 * at the same commit answers it; on another run, or none, only a running deploy of the same commit.
 * A failed or expired deploy answers nothing.
 */
async function priorOf(
  runId: string | null,
  bindingId: string,
  commit: string | null,
): Promise<SentDeploy | null> {
  const sent = await sentDeploysOf(bindingId);
  for (const d of sent) {
    const same = d.commit !== null && commit !== null && d.commit === commit;
    const unread = d.commit === null || commit === null;
    const live = d.state === 'running' || d.state === 'queued';
    if (runId !== null && d.runId === runId) {
      if ((live && (same || unread)) || (d.state === 'succeeded' && same)) return d;
    } else if (live && same) {
      return d;
    }
  }
  if (runId === null) return null;
  // queued on this run and not yet sent to Coolify: only the run's placeholder hold records it
  const holds = await readDeployHolds(runId);
  const now = Date.now();
  const queued = Object.entries(holds).find(
    ([key, h]) =>
      key.startsWith('dispatch:') &&
      h.bindingId === bindingId &&
      h.status === 'pending' &&
      Date.parse(h.deadlineAt) > now,
  );
  return queued
    ? {
        deliveryId: '',
        runId,
        targetLabel: queued[1].targetLabel,
        deploymentUuid: null,
        commit: null,
        sentAt: new Date(now),
        sentBy: null,
        state: 'queued',
      }
    : null;
}

/** Who asked, as a person reads it: their name, whether an agent, and the credential. */
async function whoSent(caller: DeployCaller | null): Promise<string | null> {
  if (!caller) return null;
  const name = (await userNames([caller.userId])).get(caller.userId) ?? caller.userId;
  return `${caller.agency === 'agent' ? 'agent ' : ''}${name} via ${caller.via}`;
}

/** The answer's line for a deploy already sent: what, its state, when, by whom, on which run. */
async function viewOf(
  integrationId: string,
  prior: SentDeploy,
  runId: string | null,
): Promise<AlreadySent> {
  const sentBy = await whoSent(prior.sentBy);
  const sentAt = prior.deliveryId ? prior.sentAt.toISOString() : null;
  const run =
    prior.runId === null ? 'with no run' : prior.runId === runId ? 'on this run' : `on run ${prior.runId}`;
  const what = prior.deploymentUuid ? `deployment ${prior.deploymentUuid}` : 'a deploy Coolify has not named yet';
  return {
    integrationId,
    deploymentUuid: prior.deploymentUuid,
    state: prior.state,
    commit: prior.commit,
    runId: prior.runId,
    sentAt,
    sentBy,
    says: `Already sent ${run}: ${what} of ${short(prior.commit)}, ${prior.state}${sentAt ? ` since ${sentAt}` : ''}${sentBy ? `, by ${sentBy}` : ''}. Not sent again; \`redeploy: true\` sends it anyway.`,
  };
}

/** Where a deploy through `bindingId` goes out, and what it would repeat where it does not. */
export async function deployOnce(args: {
  projectId: string;
  runId: string | null;
  bindingId: string;
  redeploy: boolean;
}): Promise<{ commit: DeployCommit; prior: AlreadySent | null }> {
  const commit = await deployCommitOf(args.projectId, args.bindingId);
  const prior = await priorOf(args.runId, args.bindingId, commit.commit);
  return { commit, prior: prior ? await viewOf(args.bindingId, prior, args.runId) : null };
}
