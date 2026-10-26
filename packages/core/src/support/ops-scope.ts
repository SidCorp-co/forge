// What an operations room reaches (REQ-75 BC-20): `forge`, every project of its home project's
// organization; `project`, the home project alone. Two rooms on one bot account reach what their
// own bindings say, so the same bot reads the whole organization in one room and one project in
// another. A project or an issue outside the room's scope is refused by name, never searched for.

import { orgSiblingProjects } from '../projects/index.js';
import { no, type Outcome } from './outcome.js';
import type { RoomRow } from './store.js';

export interface ScopedProject {
  id: string;
  slug: string;
  name: string;
  issuePrefix: string | null;
}

/** The projects the room reaches, its home among them. Throws when the home project is gone. */
export async function projectsInScope(room: RoomRow): Promise<ScopedProject[]> {
  const siblings = await orgSiblingProjects(room.projectId);
  const home = siblings.find((p) => p.id === room.projectId);
  if (!home) throw new Error(`support: operations room ${room.id}'s home project is gone`);
  return room.scope === 'forge' ? siblings : [home];
}

const scopeLine = (room: RoomRow, reach: readonly ScopedProject[]) =>
  `this room's scope is ${room.scope} (${reach.map((p) => p.slug).join(', ')})`;

/** The project `slug` names, when the room reaches it. */
export async function projectInScope(
  room: RoomRow,
  slug: string,
  path = '/project',
): Promise<Outcome<ScopedProject>> {
  const reach = await projectsInScope(room);
  const project = reach.find((p) => p.slug === slug.trim().toLowerCase() || p.slug === slug);
  if (project) return { ok: true, value: project };
  return no(
    'OPS_OUT_OF_SCOPE',
    path,
    `project ${slug} is not in this room's reach: ${scopeLine(room, reach)}. Ask in a room whose scope reaches it.`,
  );
}

/** The one project of the room's reach whose issue prefix `key` carries, or why there is none. */
export async function projectOfKey(
  room: RoomRow,
  key: string,
  slug: string | undefined,
): Promise<Outcome<ScopedProject>> {
  if (slug) return projectInScope(room, slug);
  const prefix = key.split('-')[0]?.toUpperCase() ?? '';
  const reach = await projectsInScope(room);
  const matching = reach.filter((p) => (p.issuePrefix ?? '').toUpperCase() === prefix);
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
    `no project in this room's reach numbers its issues ${prefix}-n: ${scopeLine(room, reach)}`,
  );
}
