import type { BindingWithConnection } from '../store.js';
import { findBindingWithConnectionById, listActiveBindingsForProjectProvider } from '../store.js';

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
