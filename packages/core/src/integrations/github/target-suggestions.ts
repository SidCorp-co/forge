/**
 * Which repository each project is offered pre-ticked when an App's repositories are bound. The
 * repository a project declared decides first; a project that declared none on GitHub is matched by
 * a repository named exactly its slug or its name, ignoring case. More than one candidate is never
 * guessed between: the project is left unticked with the candidates named. A project declaring a
 * GitHub repository this App does not see is offered nothing, never a namesake in its place.
 */

import { repositoryIdentity } from '@forge/contracts/git-repository';

export interface SuggestableProject {
  id: string;
  slug: string;
  name: string;
  /** The project document's `source.git.repository`, as declared. */
  repository: string | null;
}

export interface RepositoryTarget {
  provider: 'github';
  installationId: number;
  owner: string;
  repo: string;
}

export type TargetSuggestion =
  | { projectId: string; by: 'repository' | 'slug' | 'name'; target: RepositoryTarget }
  | { projectId: string; by: 'ambiguous'; candidates: RepositoryTarget[] };

const GITHUB_HOST = 'github.com';

const identityOf = (t: RepositoryTarget) => `${GITHUB_HOST}/${t.owner}/${t.repo}`.toLowerCase();

function declaredOnGitHub(repository: string | null): string | null {
  if (!repository) return null;
  const identity = repositoryIdentity(repository);
  return identity?.startsWith(`${GITHUB_HOST}/`) ? identity : null;
}

function suggestOne(
  project: SuggestableProject,
  targets: readonly RepositoryTarget[],
): TargetSuggestion | null {
  const declared = declaredOnGitHub(project.repository);
  if (declared) {
    const target = targets.find((t) => identityOf(t) === declared);
    return target ? { projectId: project.id, by: 'repository', target } : null;
  }
  const slug = project.slug.toLowerCase();
  const name = project.name.trim().toLowerCase();
  const bySlug = targets.filter((t) => t.repo.toLowerCase() === slug);
  const byName = targets.filter((t) => t.repo.toLowerCase() === name);
  const candidates = [...new Set([...bySlug, ...byName])];
  const [only] = candidates;
  if (!only) return null;
  if (candidates.length > 1) return { projectId: project.id, by: 'ambiguous', candidates };
  return { projectId: project.id, by: bySlug.length > 0 ? 'slug' : 'name', target: only };
}

/** One suggestion per project that has one; a project matching nothing is left out, unticked. */
export function suggestTargets(
  projects: readonly SuggestableProject[],
  targets: readonly RepositoryTarget[],
): TargetSuggestion[] {
  return projects.flatMap((p) => suggestOne(p, targets) ?? []);
}
