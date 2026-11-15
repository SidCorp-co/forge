import type { BindingWithConnection } from '../index.js';
import { findBindingWithConnectionById, listActiveBindingsForProjectProvider } from '../index.js';
import type { RocketChatBindingConfig } from './types.js';

/** This project's Rocket.Chat binding, or null. Oldest-first, so the pick is stable. */
export async function activeRocketChatBinding(
  projectId: string,
): Promise<BindingWithConnection | null> {
  const [pair] = await listActiveBindingsForProjectProvider(projectId, 'rocketchat');
  return pair ?? null;
}

export async function rocketChatBindingOfProject(
  projectId: string,
  bindingId: string,
): Promise<BindingWithConnection | null> {
  const existing = await findBindingWithConnectionById(bindingId);
  if (!existing) return null;
  if (existing.binding.projectId !== projectId) return null;
  if (existing.binding.provider !== 'rocketchat') return null;
  return existing;
}

/** Whether a connection holds a Rocket.Chat bot: the only kind a group picker may read rooms through. */
export function isRocketChatConnection(connection: { provider: string }): boolean {
  return connection.provider === 'rocketchat';
}

/** A project's own thread in a room an operations binding names (ISS-934). */
export interface ProjectThread {
  bindingId: string;
  rid: string;
  thread: string;
}

/**
 * The project's own thread in each room an active Rocket.Chat binding names, as the binding records
 * it in `operations.threads[rid][slug]` now: a room the projects of its scope share holds one thread
 * per project, and a master's post lands in its project's. The project's own bindings are read, and
 * each sibling's (`siblingIds`, the other projects of its organization) whose operations room every
 * project of the organization shares (`scope: forge`), where that room's thread for this project is
 * recorded (ISS-1242: forge's binding recorded epod's thread in Forge-Communicate, and epod's own
 * bindings never showed it).
 */
export async function projectThreadsOf(
  projectId: string,
  slug: string,
  siblingIds: readonly string[] = [],
): Promise<ProjectThread[]> {
  const out: ProjectThread[] = [];
  const homes = [projectId, ...siblingIds.filter((id) => id !== projectId)];
  for (const home of homes) {
    for (const { binding } of await listActiveBindingsForProjectProvider(home, 'rocketchat')) {
      const config = binding.config as RocketChatBindingConfig | null;
      if (home !== projectId && config?.operations?.scope !== 'forge') continue;
      for (const rid of config?.rids ?? []) {
        const thread = config?.operations?.threads?.[rid]?.[slug];
        if (thread) out.push({ bindingId: binding.id, rid, thread });
      }
    }
  }
  return out;
}
