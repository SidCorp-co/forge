import type { BindingWithConnection } from '../index.js';
import { findBindingWithConnectionById, listActiveBindingsForProjectProvider } from '../index.js';

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
