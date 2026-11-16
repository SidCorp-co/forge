// The guards over a reference source's write (ISS-1252), pure over what the service read.

import { githubRepoOf, REFERENCE_LIMITS } from '@forge/contracts/references';
import type { ProjectAccess } from '../lib/authz.js';
import type { Refusal } from '../lib/refusal.js';

/** Only a github.com repository's releases are read; anything else is refused naming what is. */
export function followRefusal(url: string, followReleases: boolean | undefined): Refusal | null {
  if (!followReleases || githubRepoOf(url)) return null;
  return {
    code: 'REFERENCE_FOLLOW_UNSUPPORTED',
    path: '/followReleases',
    detail: `${url} is not a github.com repository, and only a repository's releases and tags are followed; add it with followReleases false, or name the repository that ships it (https://github.com/<owner>/<name>)`,
  };
}

/** An org entry is the org's to write: its admin or owner, and nobody else. */
export function sharedRefusal(orgRole: ProjectAccess['orgRole']): Refusal | null {
  if (orgRole === 'admin' || orgRole === 'owner') return null;
  return {
    code: 'REFERENCE_SHARED_FORBIDDEN',
    path: '/shared',
    detail:
      "an org's reference source is shared by every project of the org, so only an org admin or owner adds, changes or removes one; add it to this project instead (shared false)",
  };
}

/** A second active entry for one address where the first is already read is refused, naming it. */
export function duplicateRefusal(
  held: { title: string; projectId: string | null } | undefined,
): Refusal | null {
  if (!held) return null;
  const where = held.projectId === null ? "the org's shared sources" : "this project's sources";
  return {
    code: 'REFERENCE_SOURCE_DUPLICATE',
    path: '/url',
    detail: `${held.title} is already among ${where}; change that entry (PATCH …/reference-sources/<source>) rather than adding it again`,
  };
}

/** The name a source is shown under: the one given, a repository's `owner/name`, or host and path. */
export function titleOf(url: string, title: string | undefined): string {
  if (title) return title;
  const repo = githubRepoOf(url);
  if (repo) return repo;
  const u = new URL(url);
  return `${u.host}${u.pathname.replace(/\/+$/, '')}`.slice(0, REFERENCE_LIMITS.title);
}

/** The same address however it was written: no trailing slash, case folded. */
export const addressKey = (url: string) => url.trim().toLowerCase().replace(/\/+$/, '');
