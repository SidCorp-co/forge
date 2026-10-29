// A room granted `build` (REQ-75 r5 BC-27): its session changes code in a writable working copy of
// the project's development branch that the box keeps for the room, and proposes a build; once a
// confirmer confirms, the box commits it on a feat/ or fix/ branch and pushes it without force, and
// core opens a change request into the development branch through the project's source host. The
// development branch is the project document's `source.git.defaultBranch`; one a production
// environment deploys from is refused by name, so nothing reaches production from chat — the release
// goes through Forge.

import { environmentsOf, readProjectDocument } from '../project-config/index.js';
import { no, type Outcome } from './outcome.js';

export interface BuildBase {
  /** Where a room's build branches from and its change request goes into. */
  base: string;
}

/**
 * The branch a room's build works from, or why it has none it may use; and, with `branch`, why that
 * branch may not be pushed: one an environment deploys from or a promotion lands on.
 */
export async function buildBaseOf(projectId: string, branch?: string): Promise<Outcome<BuildBase>> {
  const held = await readProjectDocument(projectId);
  const git = (held?.document as { source?: { git?: { defaultBranch?: unknown } } } | undefined)
    ?.source?.git;
  const base = typeof git?.defaultBranch === 'string' ? git.defaultBranch : null;
  if (!held || !base) {
    return no(
      'SUPPORT_BUILD_REFUSED',
      '/action',
      'this project declares no development branch (`source.git.defaultBranch` in its project document), so a build has nowhere to branch from or to open its change request into',
    );
  }
  const production = environmentsOf(held.document)
    .filter((e) => e.declaration.tier === 'production')
    .map((e) => e.declaration.deploysFrom)
    .filter((b): b is string => typeof b === 'string');
  if (production.includes(base)) {
    return no(
      'SUPPORT_BUILD_REFUSED',
      '/action',
      `this project's development branch ${base} is the branch production deploys from, and a build from chat never changes what production deploys: declare a development branch apart from it`,
    );
  }
  if (branch !== undefined) {
    const deployed = new Set([
      base,
      ...environmentsOf(held.document)
        .map((e) => e.declaration.deploysFrom)
        .filter((b): b is string => typeof b === 'string'),
      ...((held.document as { promotions?: { to?: unknown }[] }).promotions ?? [])
        .map((p) => p.to)
        .filter((b): b is string => typeof b === 'string'),
    ]);
    if (deployed.has(branch)) {
      return no(
        'SUPPORT_BUILD_REFUSED',
        '/branch',
        `${branch} is a branch this project deploys or promotes from, and a build from chat pushes only a branch of its own, reviewed through a change request into ${base}`,
      );
    }
  }
  return { ok: true, value: { base } };
}

/** The key of the working copy a room's session builds in: a channel agent's rooms share one (REQ-77). */
export const buildKeyOf = (room: { id: string; kind: string; bindingId: string }) =>
  room.kind === 'agent' ? room.bindingId : room.id;
