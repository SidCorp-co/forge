// The pure rules of a support room's promise (ISS-1012): which environment a name holds, whether
// Forge can ever read what it serves, and what the session is told when the promise is answered. The
// note names the issue by its title, as the person knows it; the session posts in its own words.

import type { SupportPromiseState } from '@forge/contracts/support';
import type { ProjectDocument } from '../project-config/index.js';

type Environments = ProjectDocument['environments'];
type Declaration = Environments[string];

/** The environment a person's name for it holds: the document's own name, case and spaces aside. */
export function environmentNamed(
  environments: Environments,
  asked: string,
): { name: string; declaration: Declaration } | null {
  const wanted = asked.trim().toLowerCase();
  for (const [name, declaration] of Object.entries(environments)) {
    if (name.toLowerCase() === wanted) return { name, declaration };
  }
  return null;
}

/**
 * Why Forge can never read what an environment serves, or null where it can: one deployed outside
 * Forge with no source probe has no deployment record and nothing answering its commit.
 */
export function untrackedWhy(name: string, declaration: Declaration): string | null {
  if (!('mode' in declaration.deployment)) return null;
  const probes = (declaration.verification?.runtime ?? []).filter((p) => p.identifies === 'source');
  if (probes.length > 0) return null;
  return `\`${name}\` is deployed outside Forge with no source probe, so Forge cannot read which commit it serves`;
}

/** The names a project document declares, for a refusal to list. */
export const environmentNames = (environments: Environments): string =>
  Object.keys(environments).join(', ') || 'none: its document declares no environment';

export interface PromiseFacts {
  /** The issue's title, as the person knows it. */
  title: string;
  /** Its key, for the session's own record; never posted. */
  key: string;
  environment: string;
  /** The member's name as the group shows it, or their account id. */
  asker: string;
}

const HOW =
  'Post it once, in this thread, in your own words and the persona of this room: name the work by what the person knows it as, never by a key, an id or a commit. Nothing else is owed on this promise.';

/** What the session is told when a promise is answered, to tell the person in its thread. */
export function promiseNote(state: Exclude<SupportPromiseState, 'open'>, f: PromiseFacts): string {
  const what = `You promised ${f.asker} in this thread to tell them when "${f.title}" (${f.key}) reaches ${f.environment}.`;
  switch (state) {
    case 'reached':
      return `${what} It has: ${f.environment} now runs a build holding that work. Tell ${f.asker} it is on ${f.environment} now. ${HOW}`;
    case 'dropped':
      return `${what} It never will: the team dropped that work. Tell ${f.asker} it will not reach ${f.environment}, and that nothing more will come of this promise. ${HOW}`;
    case 'untracked':
      return `${what} Forge can no longer read what ${f.environment} serves, so this promise cannot be kept. Tell ${f.asker} you can no longer tell them when it gets there. ${HOW}`;
  }
}
