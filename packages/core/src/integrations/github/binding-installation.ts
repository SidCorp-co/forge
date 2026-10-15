/**
 * A binding of the instance's App names an installation, and the installation is what reaches the
 * repository: it must be recorded for the binding project's own org and still be live on GitHub.
 * A binding of an App a person or org owns is not judged here; its installations are its owner's.
 */

import type { Said } from '@forge/contracts/said';
import { say } from '@forge/contracts/said';
import { projectOrgOf } from '../../lib/authz.js';
import type { BindingTargetRefusal, BindingWithConnection } from '../index.js';
import { effectiveConfig } from '../index.js';
import {
  findInstallation,
  type GithubAppInstallationRow,
  listInstallationsOf,
} from './installations.js';
import type { GitHubConfig } from './types.js';

const notRecorded = (detail: string): BindingTargetRefusal[] => [
  { code: 'GITHUB_INSTALLATION_NOT_RECORDED', path: '/installationId', detail },
];

const stateWords = { suspended: 'suspended', gone: 'removed' } as const;

export async function installationRefusals(args: {
  projectId: string;
  connection: { id: string; ownerType: string };
  config: Record<string, unknown>;
  held: Record<string, unknown> | null;
}): Promise<BindingTargetRefusal[]> {
  if (args.connection.ownerType !== 'instance') return [];
  const id = args.config.installationId;
  if (typeof id !== 'number') return [];
  // a binding already holding this installation was admitted when it was written
  if (args.held?.installationId === id) return [];
  const row = await findInstallation(args.connection.id, id);
  if (!row) {
    return notRecorded(
      `installation ${id} of this GitHub App is not recorded for any Forge organisation; an admin of this project's organisation installs the App through Connect GitHub, which records the installation once GitHub shows it is theirs.`,
    );
  }
  const orgId = await projectOrgOf(args.projectId);
  if (row.orgId !== orgId) {
    return notRecorded(
      `installation ${id} (${row.accountLogin}) is recorded for another Forge organisation than this project's, and an installation is never moved between organisations.`,
    );
  }
  if (row.state !== 'active') {
    return notRecorded(
      `installation ${id} (${row.accountLogin}) was ${stateWords[row.state]} on GitHub; install the App on ${row.accountLogin} again through Connect GitHub.`,
    );
  }
  return [];
}

/** Why a binding's installation no longer reaches its repository, or null where it does. */
function standingOf(config: GitHubConfig, row: GithubAppInstallationRow | undefined): Said | null {
  const id = config.installationId;
  if (typeof id !== 'number') return null;
  if (!row)
    return say('integrations.health.github.installationUnrecorded', { installation: String(id) });
  if (row.state === 'gone') {
    return say('integrations.health.github.installationGone', { account: row.accountLogin });
  }
  if (row.state === 'suspended') {
    return say('integrations.health.github.installationSuspended', { account: row.accountLogin });
  }
  const repository = config.owner && config.repo ? `${config.owner}/${config.repo}` : null;
  if (
    repository &&
    row.removedRepositories.some((name) => name.toLowerCase() === repository.toLowerCase())
  ) {
    return say('integrations.health.github.repositoryRemoved', {
      repository,
      account: row.accountLogin,
    });
  }
  return null;
}

/**
 * Binding id → why it reads degraded, for the GitHub bindings of the instance's App: its
 * installation was removed or suspended on GitHub, the repository was taken off it, or it was
 * never recorded. A binding is never deleted for it; it says why it cannot work.
 */
export async function installationStandings(
  pairs: readonly BindingWithConnection[],
): Promise<Map<string, Said>> {
  const out = new Map<string, Said>();
  const byConnection = new Map<string, BindingWithConnection[]>();
  for (const pair of pairs) {
    if (pair.binding.provider !== 'github' || pair.connection.ownerType !== 'instance') continue;
    byConnection.set(pair.connection.id, [...(byConnection.get(pair.connection.id) ?? []), pair]);
  }
  for (const [connectionId, held] of byConnection) {
    const configs = held.map((pair) => ({ pair, config: effectiveConfig<GitHubConfig>(pair) }));
    const ids = configs
      .map((c) => c.config.installationId)
      .filter((id): id is number => typeof id === 'number');
    const rows = await listInstallationsOf(connectionId, ids);
    for (const { pair, config } of configs) {
      const said = standingOf(
        config,
        rows.find((r) => r.installationId === config.installationId),
      );
      if (said) out.set(pair.binding.id, said);
    }
  }
  return out;
}
