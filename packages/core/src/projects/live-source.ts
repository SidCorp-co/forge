import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectGitCredentials, projects, workspaceSshKeys } from '../db/schema.js';
import { GIT_ACCESS, hostOf, KEY_ACCESS, WHY_KEY_ACCESS } from '../git/bounded-fetch.js';
import { classifyGitRemote } from '../git/provision-credential.js';
import { type BranchRefs, readRemoteDivergence } from '../git/remote-divergence.js';
import {
  GitHubClientError,
  type GitHubRepoClient,
  githubRepoClient,
} from '../integrations/github/client.js';
import { type LiveDivergence, readLiveDivergence } from '../integrations/github/live-divergence.js';
import { decryptSecret, isVaultConfigured } from '../integrations/vault.js';
import { type Refused, type RepositoryRoute, saying } from './repository-reader.js';

/** Where a project's branches are read from, or why they cannot be. */
export type LiveSource =
  | { kind: 'binding'; client: GitHubRepoClient }
  | { kind: 'deploy_key'; repoUrl: string; privateKey: string }
  | ({
      kind: 'refused';
      /** `cause` and `clears` as one sentence. */
      reason: string;
      /** No route was declared: neither a GitHub binding nor a deploy key beside a repository URL. */
      unbound: boolean;
      /** The route the reason is about, so a sentence around it names the one to repair. */
      route: RepositoryRoute;
    } & Refused);

export interface DeployKeyRow {
  repoUrl: string | null;
  privateKeyEnc: Buffer | null;
}

export interface LiveSourceDeps {
  githubClient: (projectId: string) => Promise<GitHubRepoClient>;
  deployKey: (projectId: string) => Promise<DeployKeyRow>;
}

async function deployKeyRow(projectId: string): Promise<DeployKeyRow> {
  const [row] = await db
    .select({ repoUrl: projects.repoUrl, privateKeyEnc: workspaceSshKeys.privateKeyEnc })
    .from(projects)
    .leftJoin(projectGitCredentials, eq(projectGitCredentials.projectId, projects.id))
    .leftJoin(workspaceSshKeys, eq(workspaceSshKeys.id, projectGitCredentials.sshKeyId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? { repoUrl: null, privateKeyEnc: null };
}

const defaultDeps: LiveSourceDeps = {
  githubClient: githubRepoClient,
  deployKey: deployKeyRow,
};

function noCredential(repoUrl: string | null): Refused {
  if (!repoUrl?.trim()) {
    return {
      cause:
        'this project has no GitHub binding and names no repository URL, so there is no repository to read',
      clears: `set an SSH clone URL and a deploy key under ${GIT_ACCESS}`,
    };
  }
  const host = hostOf(repoUrl);
  const github = host === 'github.com' ? ', or bind the repository on its Integrations page' : '';
  return {
    cause: `Forge holds no GitHub binding and no deploy key for this project's repository on ${host}, so it cannot read the repository`,
    clears: `attach a deploy key with ${KEY_ACCESS} to ${repoUrl.trim()} under ${GIT_ACCESS} (${WHY_KEY_ACCESS})${github}`,
  };
}

function refused(said: Refused, unbound: boolean, route: RepositoryRoute): LiveSource {
  return { kind: 'refused', reason: saying(said), ...said, unbound, route };
}

/**
 * Where to read a project's branches: its active GitHub binding, else — only where it has no
 * binding at all — the deploy key attached to it. A binding that exists and cannot be used is a
 * refusal in its own words, never answered from the key instead.
 */
export async function resolveLiveSource(
  projectId: string,
  deps: LiveSourceDeps = defaultDeps,
): Promise<LiveSource> {
  try {
    return { kind: 'binding', client: await deps.githubClient(projectId) };
  } catch (err) {
    if (!(err instanceof GitHubClientError)) throw err;
    if (err.reason !== 'no_binding') {
      return refused({ cause: err.message }, false, 'binding');
    }
  }
  const row = await deps.deployKey(projectId);
  const repoUrl = row.repoUrl?.trim() ?? '';
  if (!row.privateKeyEnc || !repoUrl) {
    return refused(noCredential(repoUrl), true, 'deploy_key');
  }
  const keyRefused = (said: Refused) => refused(said, false, 'deploy_key');
  if (classifyGitRemote(repoUrl) !== 'ssh') {
    return keyRefused({
      cause: `this project's repository URL ${repoUrl} is not an SSH remote, so its deploy key cannot read it`,
      clears: `set an SSH clone URL (git@host:org/repo.git) under ${GIT_ACCESS}`,
    });
  }
  if (!isVaultConfigured()) {
    return keyRefused({
      cause:
        "this Forge has no secret vault configured (INTEGRATION_MASTER_KEY), so the project's deploy key cannot be read",
    });
  }
  let privateKey: string;
  try {
    privateKey = decryptSecret(row.privateKeyEnc);
  } catch {
    return keyRefused({
      cause:
        'the deploy key attached to this project could not be decrypted (the vault master key may have rotated)',
      clears: `attach it again under ${GIT_ACCESS}`,
    });
  }
  return { kind: 'deploy_key', repoUrl, privateKey };
}

export interface ProjectDivergenceDeps {
  source: (projectId: string) => Promise<LiveSource>;
  github: typeof readLiveDivergence;
  deployKey: typeof readRemoteDivergence;
}

const divergenceDeps: ProjectDivergenceDeps = {
  source: resolveLiveSource,
  github: readLiveDivergence,
  deployKey: readRemoteDivergence,
};

/** The commits on base that live lacks, read through whichever source the project holds. */
export async function readProjectDivergence(
  projectId: string,
  refs: BranchRefs,
  deps: ProjectDivergenceDeps = divergenceDeps,
): Promise<LiveDivergence> {
  const source = await deps.source(projectId);
  if (source.kind === 'refused') return { ok: false, reason: source.reason };
  if (source.kind === 'binding') return deps.github(source.client, refs);
  return deps.deployKey(source, refs);
}
