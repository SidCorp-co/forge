import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectGitCredentials, projects, workspaceSshKeys } from '../db/schema.js';
import { classifyGitRemote } from '../git/provision-credential.js';
import { type BranchRefs, GIT_ACCESS, readRemoteDivergence } from '../git/remote-divergence.js';
import {
  GitHubClientError,
  type GitHubRepoClient,
  githubRepoClient,
} from '../integrations/github/client.js';
import { type LiveDivergence, readLiveDivergence } from '../integrations/github/live-divergence.js';
import { decryptSecret, isVaultConfigured } from '../integrations/vault.js';

/** Where a project's branches are read from, or why they cannot be. */
export type LiveSource =
  | { kind: 'binding'; client: GitHubRepoClient }
  | { kind: 'deploy_key'; repoUrl: string; privateKey: string }
  | { kind: 'refused'; reason: string };

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

/** The host a remote names, for a sentence; the URL itself where no host can be read from it. */
function hostOf(repoUrl: string): string {
  const u = repoUrl.trim();
  try {
    if (u.includes('://')) return new URL(u).hostname || u;
  } catch {
    return u;
  }
  return u.match(/^[^@\s]+@([^:\s/]+):/)?.[1] ?? u;
}

function noCredential(repoUrl: string | null): string {
  if (!repoUrl?.trim()) {
    return `this project has no GitHub binding and names no repository URL, so there are no branches to read — set an SSH clone URL and a deploy key under ${GIT_ACCESS}`;
  }
  const host = hostOf(repoUrl);
  const github = host === 'github.com' ? ', or bind the repository on its Integrations page' : '';
  return `Forge holds no GitHub binding and no deploy key for this project's repository on ${host}, so it cannot read the branches — attach a deploy key under ${GIT_ACCESS}${github}`;
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
    if (err.reason !== 'no_binding') return { kind: 'refused', reason: err.message };
  }
  const row = await deps.deployKey(projectId);
  const repoUrl = row.repoUrl?.trim() ?? '';
  if (!row.privateKeyEnc || !repoUrl) return { kind: 'refused', reason: noCredential(repoUrl) };
  if (classifyGitRemote(repoUrl) !== 'ssh') {
    return {
      kind: 'refused',
      reason: `this project's repository URL ${repoUrl} is not an SSH remote, so its deploy key cannot read it — set an SSH clone URL (git@host:org/repo.git) under ${GIT_ACCESS}`,
    };
  }
  if (!isVaultConfigured()) {
    return {
      kind: 'refused',
      reason:
        "this Forge has no secret vault configured (INTEGRATION_MASTER_KEY), so the project's deploy key cannot be read",
    };
  }
  let privateKey: string;
  try {
    privateKey = decryptSecret(row.privateKeyEnc);
  } catch {
    return {
      kind: 'refused',
      reason: `the deploy key attached to this project could not be decrypted (the vault master key may have rotated) — attach it again under ${GIT_ACCESS}`,
    };
  }
  return { kind: 'deploy_key', repoUrl, privateKey };
}

export interface ProjectDivergenceDeps {
  source: (projectId: string) => Promise<LiveSource>;
  github: typeof readLiveDivergence;
  deployKey: typeof readRemoteDivergence;
}

const divergenceDeps: ProjectDivergenceDeps = {
  source: (projectId) => resolveLiveSource(projectId),
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
