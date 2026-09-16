/**
 * Where "which Rocket.Chat binding does this project use" is answered.
 *
 * ISS-1071 rule 1 — the provider's name belongs in the provider's own directory. Three callers
 * outside it were each writing `listActiveBindingsForProjectProvider(projectId, 'rocketchat')`:
 * the assistant's speaker directory, the question-delivery path, and the generic integrations
 * router's Rocket.Chat endpoint. Three copies of one question is three places to edit when the
 * answer changes, and — more to the point — three files that had to know a provider called
 * `rocketchat` exists in order to do their own jobs.
 */

import { findBindingWithConnectionById, listActiveBindingsForProjectProvider } from '../store.js';
import type { BindingWithConnection } from '../store.js';

/** This project's Rocket.Chat binding, or null. Oldest-first, so the pick is stable. */
export async function activeRocketChatBinding(
  projectId: string,
): Promise<BindingWithConnection | null> {
  const [pair] = await listActiveBindingsForProjectProvider(projectId, 'rocketchat');
  return pair ?? null;
}

/**
 * One NAMED Rocket.Chat binding of this project, or null when the id is not one.
 *
 * Returns null rather than throwing for all three ways it can miss — absent, another project's, or
 * another provider's — because the caller answers 404 for each: distinguishing them in the response
 * would confirm to a non-member that a binding id exists and which project holds it.
 */
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
