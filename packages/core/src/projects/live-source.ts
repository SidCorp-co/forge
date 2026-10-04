import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectGitCredentials, workspaceSshKeys } from '../db/schema.js';
import { type BranchRefs, GIT_ACCESS, readRemoteDivergence } from '../git/index.js';
import { decryptSecret, isVaultConfigured } from '../integrations/index.js';
import {
  type LiveDivergence,
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { readDeclaredSource, remoteOf } from '../project-config/index.js';

/** Where a project's branches are read from, or why they cannot be. */
type LiveSource =
  | { kind: 'binding'; host: SourceHost }
  | { kind: 'deploy_key'; repoUrl: string; privateKey: string }
  | { kind: 'refused'; reason: string };

interface DeployKeyRow {
  repository: string | null;
  privateKeyEnc: Buffer | null;
}

interface LiveSourceDeps {
  sourceHost: (projectId: string) => Promise<SourceHost>;
  deployKey: (projectId: string) => Promise<DeployKeyRow>;
}

async function deployKeyRow(projectId: string): Promise<DeployKeyRow> {
  const [row] = await db
    .select({ privateKeyEnc: workspaceSshKeys.privateKeyEnc })
    .from(projectGitCredentials)
    .innerJoin(workspaceSshKeys, eq(workspaceSshKeys.id, projectGitCredentials.sshKeyId))
    .where(eq(projectGitCredentials.projectId, projectId))
    .limit(1);
  const { repository } = await readDeclaredSource(projectId);
  return { repository, privateKeyEnc: row?.privateKeyEnc ?? null };
}

const defaultDeps: LiveSourceDeps = {
  sourceHost: (projectId) => resolveSourceHost(projectId, 'kernel'),
  deployKey: deployKeyRow,
};

function noCredential(repository: string | null): string {
  if (!repository) {
    return `this project has no source host binding and its document declares no repository, so there are no branches to read — set \`source.git.repository\` with PUT /api/projects/:id/config and attach a deploy key under ${GIT_ACCESS}`;
  }
  const host = repository.slice(0, repository.indexOf('/'));
  return `Forge holds no source host binding and no deploy key for this project's repository on ${host}, so it cannot read the branches — attach a deploy key under ${GIT_ACCESS}, or bind the repository's host on its Integrations page`;
}

/**
 * Where to read a project's branches: its active source host binding, else — only where it has no
 * binding at all — the deploy key attached to it. A binding that exists and cannot be used is a
 * refusal in its own words, never answered from the key instead.
 */
async function resolveLiveSource(
  projectId: string,
  deps: LiveSourceDeps = defaultDeps,
): Promise<LiveSource> {
  try {
    return { kind: 'binding', host: await deps.sourceHost(projectId) };
  } catch (err) {
    if (!(err instanceof SourceHostUnavailable)) throw err;
    if (err.reason !== 'no_binding') return { kind: 'refused', reason: err.message };
  }
  const row = await deps.deployKey(projectId);
  if (!row.privateKeyEnc || !row.repository) {
    return { kind: 'refused', reason: noCredential(row.repository) };
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
  return { kind: 'deploy_key', repoUrl: remoteOf(row.repository, 'ssh'), privateKey };
}

interface ProjectDivergenceDeps {
  source: (projectId: string) => Promise<LiveSource>;
  deployKey: typeof readRemoteDivergence;
}

const divergenceDeps: ProjectDivergenceDeps = {
  source: resolveLiveSource,
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
  if (source.kind === 'binding') return source.host.readDivergence(refs);
  return deps.deployKey(source, refs);
}
