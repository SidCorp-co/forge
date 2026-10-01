import type { ProjectDocument } from './schema.js';
import { readProjectDocument } from './service.js';

export type GitTransport = 'ssh' | 'https';

export function repositoryOf(document: ProjectDocument | null | undefined): string | null {
  return document?.source.type === 'git' ? document.source.git.repository : null;
}

export function defaultBranchOf(document: ProjectDocument | null | undefined): string | null {
  return document?.source.type === 'git' ? document.source.git.defaultBranch : null;
}

export function setupOf(document: ProjectDocument | null | undefined): string | null {
  return document?.workspace.setup ?? null;
}

export function remoteOf(repository: string, transport: GitTransport): string {
  const slash = repository.indexOf('/');
  const host = repository.slice(0, slash);
  const path = repository.slice(slash + 1);
  return transport === 'ssh' ? `git@${host}:${path}.git` : `https://${host}/${path}.git`;
}

export function webUrlOf(repository: string): string {
  return `https://${repository}`;
}

export interface DeclaredSource {
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

export async function withDefaultBranch<T extends { projectId: string }>(
  rows: readonly T[],
): Promise<(T & { baseBranch: string | null })[]> {
  const branches = new Map<string, string | null>();
  for (const projectId of new Set(rows.map((r) => r.projectId))) {
    branches.set(projectId, (await readDeclaredSource(projectId)).defaultBranch);
  }
  return rows.map((r) => ({ ...r, baseBranch: branches.get(r.projectId) ?? null }));
}

export const NO_REPOSITORY =
  "this project's document declares no repository: set `source.git.repository` with PUT /api/projects/:id/config";
