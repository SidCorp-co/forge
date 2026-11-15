// What a room reaches (REQ-75 BC-20, ISS-1243 item 11): every room agent, a support group's, a channel
// agent's and an operations room's of either scope, reaches every project of its home project's
// organization, its home first, routing by the turn's signals rather than by a list wired per room.
// A channel agent's `agent.projects` (ISS-874) is a hint read next after its home, never a fence: it
// still says which checkouts the agent's box mounts and where a product's other halves post. A
// project outside the organization, or an issue under no prefix of it, is refused by name, never
// searched for.

import { findBindingWithConnectionById } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import { orgSiblingProjects } from '../projects/index.js';
import { no, type Outcome } from './outcome.js';
import type { RoomRow } from './store.js';

export interface ScopedProject {
  id: string;
  slug: string;
  name: string;
  issuePrefix: string | null;
}

/** What a room reaches, and the slugs its binding names that no project of the organization holds now. */
interface Reach {
  projects: ScopedProject[];
  unknown: string[];
}

/** The sibling slugs a channel agent's binding names in `agent.projects`, as it holds them now. */
export async function agentProjectSlugs(room: Pick<RoomRow, 'kind' | 'bindingId'>) {
  if (room.kind !== 'agent') return [];
  const pair = await findBindingWithConnectionById(room.bindingId);
  return ((pair?.binding.config ?? null) as RocketChatBindingConfig | null)?.agent?.projects ?? [];
}

async function reachOf(room: RoomRow): Promise<Reach> {
  const siblings = await orgSiblingProjects(room.projectId);
  const home = siblings.find((p) => p.id === room.projectId);
  if (!home) throw new Error(`support: room ${room.id}'s home project is gone`);
  // the projects a channel agent's binding names come right after its home, as hints (ISS-1243)
  const named = await agentProjectSlugs(room);
  const hinted = named.flatMap((slug) =>
    siblings.filter((p) => p.slug === slug && p.id !== home.id),
  );
  const rest = siblings.filter((p) => p.id !== home.id && !hinted.includes(p));
  return {
    projects: [home, ...hinted, ...rest],
    unknown: named.filter((slug) => !siblings.some((p) => p.slug === slug)),
  };
}

/** The projects the room reaches, its home first. Throws when the home project is gone. */
export async function projectsInScope(room: RoomRow): Promise<ScopedProject[]> {
  return (await reachOf(room)).projects;
}

const scopeLine = (reach: Reach) => {
  const slugs = reach.projects.map((p) => p.slug).join(', ');
  const gone = reach.unknown.length
    ? `; its binding also names ${reach.unknown.join(', ')}, which no project of this organization is now`
    : '';
  return `this room reaches every project of its organization (${slugs})${gone}`;
};

/** The project `slug` names, when the room reaches it. */
export async function projectInScope(
  room: RoomRow,
  slug: string,
  path = '/project',
): Promise<Outcome<ScopedProject>> {
  const reach = await reachOf(room);
  const project = reach.projects.find(
    (p) => p.slug === slug.trim().toLowerCase() || p.slug === slug,
  );
  if (project) return { ok: true, value: project };
  return no(
    'OPS_OUT_OF_SCOPE',
    path,
    `project ${slug} is no project of this room's organization: ${scopeLine(reach)}. Name one of them.`,
  );
}

/** The project a session's act names, its home project where it names none (ISS-874). */
export async function namedProject(
  room: RoomRow,
  slug: string | undefined,
  path = '/project',
): Promise<Outcome<ScopedProject>> {
  if (slug !== undefined) return projectInScope(room, slug, path);
  const home = (await reachOf(room)).projects[0];
  if (!home) throw new Error(`support: room ${room.id}'s home project is gone`);
  return { ok: true, value: home };
}

/** The one project of the room's reach whose issue prefix `key` carries, or why there is none. */
export async function projectOfKey(
  room: RoomRow,
  key: string,
  slug: string | undefined,
): Promise<Outcome<ScopedProject>> {
  if (slug) return projectInScope(room, slug);
  const prefix = key.split('-')[0]?.toUpperCase() ?? '';
  const reach = await reachOf(room);
  // a project with no prefix of its own numbers its issues ISS-n, as every read names them (`keyOf`)
  const matching = reach.projects.filter((p) => (p.issuePrefix ?? 'ISS').toUpperCase() === prefix);
  if (matching.length === 1 && matching[0]) return { ok: true, value: matching[0] };
  if (matching.length > 1) {
    return no(
      'OPS_OUT_OF_SCOPE',
      '/project',
      `${key}'s prefix ${prefix} is shared by ${matching.map((p) => p.slug).join(', ')}; name the project as well`,
    );
  }
  return no(
    'OPS_OUT_OF_SCOPE',
    '/issue',
    `no project in this room's reach numbers its issues ${prefix}-n: ${scopeLine(reach)}`,
  );
}
