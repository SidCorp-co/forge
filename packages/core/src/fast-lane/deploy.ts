// The fast lane's web-only deploy (REQ-39 BC-7; docs/proposals/live-preview.md, "The web-only deploy
// guard"): a deploy of the targets `fastLane.deployTargets` names, and no others, refused unless
// every commit between what each of them serves and the head its environment deploys from
// classifies fast. Otherwise web would ship ahead of a core change it needs. What cannot be read
// whole — the served commit, the range, a commit's files — refuses FAST_LANE_UNVERIFIED: unread is
// never taken as fast. The deploy itself is the release path's (`release-batch:runCoolifyDeploy`),
// handed the labels.

import type { FastLaneRefusalCode } from '@forge/contracts/fast-lane';
import {
  buildClient,
  type CoolifyConfig,
  type CoolifySecrets,
} from '../integrations/deploy/index.js';
import { buildContextFromBinding } from '../integrations/index.js';
import { resolveSourceHost, type SourceHost } from '../integrations/source-host/index.js';
import { refuser } from '../lib/refusal.js';
import { readProjectDocument } from '../project-config/index.js';
import {
  activeCoolifyIntegrations,
  type CoolifyIntegrationRow,
  resolveIntegrationRow,
  runCoolifyDeploy,
} from '../release-batch/index.js';
import { deployRangeRefusal, deployTargetsRefusal, type RangeCommit } from './rules.js';

const refuse = refuser<FastLaneRefusalCode>('FAST_LANE_NOT_ELIGIBLE');

type RangeHost = Pick<SourceHost, 'branchHead' | 'readRange' | 'commitFiles'>;

/** How many of a target's latest deployments are read to find the one it serves. */
const DEPLOYMENTS_READ = 20;
const REVISION = /^[0-9a-f]{7,40}$/i;

const unverified = (detail: string): never => {
  throw refuse('FAST_LANE_UNVERIFIED', `${detail}. Nothing was deployed`, '/targets');
};

/** What one target serves: the commit of its latest finished deployment, read from Coolify. */
async function servedCommitOf(
  row: CoolifyIntegrationRow,
  target: { label: string; resourceUuid: string },
): Promise<string> {
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(row.pair);
  let deployments: { status?: string; commit?: string; created_at?: string }[];
  try {
    const page = await buildClient(ctx).listApplicationDeployments(target.resourceUuid, {
      skip: 0,
      take: DEPLOYMENTS_READ,
    });
    deployments = page.deployments ?? [];
  } catch (err) {
    return unverified(
      `Coolify did not answer which commit "${target.label}" serves (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const finished = deployments
    .filter((d) => d.status === 'finished' && typeof d.commit === 'string')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const latest = finished[0];
  if (!latest?.commit || !REVISION.test(latest.commit)) {
    return unverified(
      latest
        ? `"${target.label}"'s latest finished deployment records commit ${JSON.stringify(latest.commit)}, which names no revision, so what it serves is unknown`
        : `none of "${target.label}"'s latest ${DEPLOYMENTS_READ} deployments finished, so what it serves is unknown`,
    );
  }
  return latest.commit.toLowerCase();
}

/** The commits `served..head` holds, each with the files it changed, read whole or refused. */
async function rangeOf(host: RangeHost, served: string, head: string): Promise<RangeCommit[]> {
  const range = await host.readRange(served, head);
  if (!range.ok)
    return unverified(
      `the commits ${served.slice(0, 12)}..${head.slice(0, 12)} could not be read: ${range.reason}`,
    );
  if (!range.complete) {
    return unverified(
      `the host listed fewer commits than ${served.slice(0, 12)}..${head.slice(0, 12)} holds, so the range cannot be shown fast`,
    );
  }
  const commits: RangeCommit[] = [];
  for (const c of range.commits) {
    const files = await host.commitFiles(c.sha);
    if ('why' in files)
      return unverified(
        `the files of ${c.sha.slice(0, 12)} could not be named whole: ${files.why}`,
      );
    commits.push({ sha: c.sha, files: files.files });
  }
  return commits;
}

export interface WebOnlyDeployInput {
  projectId: string;
  issueId?: string | undefined;
  integrationId?: string | undefined;
  /** The labels of the binding's targets to deploy: each must be among `fastLane.deployTargets`. */
  targets: readonly string[];
}

/**
 * Deploy only `targets`, once the guard holds for each: the project declares them, the binding holds
 * them, and every commit between what each serves and its environment's head is fast.
 */
export async function deployWebOnly(
  input: WebOnlyDeployInput,
  deps: { host?: () => Promise<RangeHost> } = {},
) {
  const { projectId } = input;
  const document = (await readProjectDocument(projectId))?.document ?? null;
  const settings = document?.fastLane ?? null;
  const row = resolveIntegrationRow(await activeCoolifyIntegrations(projectId), input);
  if (!row && settings) {
    throw refuse(
      'FAST_LANE_UNDECLARED',
      'the project has no active Coolify deploy binding, so there is no web target to deploy. Nothing was deployed',
      '/targets',
    );
  }
  const bound = (row?.config as CoolifyConfig | null)?.targets ?? [];
  const named = deployTargetsRefusal({
    settings,
    labels: input.targets,
    bound: bound.map((t) => t.label),
  });
  if (named) throw refuse(named.code, named.detail, named.path);
  if (!row || !settings)
    throw new Error('fast-lane: the guard passed with no binding or no declaration');

  const environment = row.environment ? document?.environments[row.environment] : undefined;
  const branch = environment?.deploysFrom;
  if (!branch) {
    return unverified(
      `the binding deploys ${row.environment ? `environment \`${row.environment}\`, which declares no \`deploysFrom\`` : 'no environment the project document names'}, so the head it would ship is unknown`,
    );
  }
  let host: RangeHost;
  let head: string;
  try {
    host = await (deps.host ?? (() => resolveSourceHost(projectId)))();
    head = (await host.branchHead(branch)).toLowerCase();
  } catch (err) {
    return unverified(
      `the repository could not be read for ${branch}'s head (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const shipped: { label: string; served: string; head: string; commits: number }[] = [];
  for (const label of input.targets) {
    const target = bound.find((t) => t.label === label);
    if (!target) continue;
    const served = await servedCommitOf(row, target);
    const commits = await rangeOf(host, served, head);
    const refusal = deployRangeRefusal({ settings, label, served, head, commits });
    if (refusal) throw refuse(refusal.code, refusal.detail, refusal.path);
    shipped.push({ label, served, head, commits: commits.length });
  }

  const outcome = await runCoolifyDeploy({
    projectId,
    integrationId: row.id,
    ...(input.issueId ? { issueId: input.issueId } : {}),
    targetLabels: input.targets,
  });
  return { ...outcome, lane: 'fast' as const, targets: shipped };
}
