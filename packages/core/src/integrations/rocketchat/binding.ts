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
 * The project's own thread in each room its active Rocket.Chat bindings name, as each binding
 * records it in `operations.threads[rid][slug]` now: a room the projects of its scope share holds
 * one thread per project, and a master's post lands in its project's.
 */
export async function projectThreadsOf(projectId: string, slug: string): Promise<ProjectThread[]> {
  const out: ProjectThread[] = [];
  for (const { binding } of await listActiveBindingsForProjectProvider(projectId, 'rocketchat')) {
    const config = binding.config as RocketChatBindingConfig | null;
    for (const rid of config?.rids ?? []) {
      const thread = config?.operations?.threads?.[rid]?.[slug];
      if (thread) out.push({ bindingId: binding.id, rid, thread });
    }
  }
  return out;
}
