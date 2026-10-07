import { parseRepository } from '@forge/contracts/git-repository';
import { defaultBranchOf } from './promotion-path.js';
import type { ProjectDocument } from './schema.js';
import { readProjectDocument } from './service.js';

export {
  hostOf,
  parseRepository,
  type RepositoryRef,
  repositoryIdentity,
} from '@forge/contracts/git-repository';

export function repositoryOf(document: ProjectDocument | null | undefined): string | null {
  return document?.source.type === 'git' ? document.source.git.repository : null;
}

function setupOf(document: ProjectDocument | null | undefined): string | null {
  return document?.workspace.setup ?? null;
}

/** Where a checkout clones from: https for a hosted name, the SSH remote or local path as declared. */
export function remoteOf(repository: string): string {
  const ref = parseRepository(repository);
  return ref.kind === 'hosted' ? `https://${ref.host}/${ref.path}.git` : repository;
}

/** The repository's page on its host; null for a local path, which has none. */
export function webUrlOf(repository: string): string | null {
  const ref = parseRepository(repository);
  return ref.kind === 'local' ? null : `https://${ref.host}/${ref.path}`;
}

interface DeclaredSource {
  repository: string | null;
  defaultBranch: string | null;
  setup: string | null;
}

export async function readDeclaredSource(projectId: string): Promise<DeclaredSource> {
  const held = await readProjectDocument(projectId);
  return {
    repository: repositoryOf(held?.document),
    defaultBranch: defaultBranchOf(held?.document),
    setup: setupOf(held?.document),
  };
}

/** Each row with its project's declared `repository`, `baseBranch` and `workspaceSetup`, one document read per project. */
export async function withDeclaredSource<T extends { projectId: string }>(
  rows: readonly T[],
): Promise<
  (T & { repository: string | null; baseBranch: string | null; workspaceSetup: string | null })[]
> {
  const sources = new Map<string, DeclaredSource>();
  for (const projectId of new Set(rows.map((r) => r.projectId))) {
    sources.set(projectId, await readDeclaredSource(projectId));
  }
  return rows.map((r) => ({
    ...r,
    repository: sources.get(r.projectId)?.repository ?? null,
    baseBranch: sources.get(r.projectId)?.defaultBranch ?? null,
    workspaceSetup: sources.get(r.projectId)?.setup ?? null,
  }));
}
