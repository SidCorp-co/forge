import { AGENT_EMAIL_DOMAIN } from '../auth/agent-account.js';
import type { Tx } from '../db/client.js';
import { users } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';

/** Forge's own account, so what a sweep writes is never charged to a person. In no organization. */
export const FORGE_AUTHOR_ID = 'ae41e0c9-5340-4854-9dc2-5d88fc6f567a';

/** The id Forge writes under, its account minted on first use. */
export async function forgeAuthorId(executor: Tx): Promise<string> {
  await executor
    .insert(users)
    .values({
      id: FORGE_AUTHOR_ID,
      email: `forge@${AGENT_EMAIL_DOMAIN}`,
      kind: 'agent',
      displayName: 'Forge',
      passwordHash: null,
      emailVerifiedAt: new Date(),
    })
    .onConflictDoNothing({ target: users.id });
  return FORGE_AUTHOR_ID;
}

export async function forgeActor(executor: Tx): Promise<TransitionActor> {
  return { type: 'user', id: await forgeAuthorId(executor), agency: 'agent' };
}

/** A user as the actor of a move: Forge reads as the agent it is, anyone else as they stand. */
export function userActor(id: string): TransitionActor {
  return id === FORGE_AUTHOR_ID ? { type: 'user', id, agency: 'agent' } : { type: 'user', id };
}
