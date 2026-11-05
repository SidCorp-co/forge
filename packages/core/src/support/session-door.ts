// The one door every session act of a room passes through over REST (REQ-75): the act run as the
// room's own session under its current turn's token (`acts.ts:supportAct`), a refusal answered by
// name. Shared by the routers that mount session acts (`routes.ts`, `promise-routes.ts`).

import type { Context } from 'hono';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { requiresNoPermission } from '../permissions/index.js';
import { type SupportActInput, supportAct } from './acts.js';

/** What every session act declares: its door admits the room's own session, never a permission. */
export const SESSION_ONLY = requiresNoPermission(
  "only the room's own session, under its current turn's token, is admitted (support/access.ts)",
);

/** One act of the room's session; `rid` names the group where the act names no thread of it. */
export async function act(
  c: Context<{ Variables: AuthVars }>,
  projectId: string,
  input: SupportActInput,
  rid?: string,
) {
  const out = await supportAct(
    { userId: c.get('userId'), tokenId: c.get('patTokenId'), projectId },
    input,
    { rid },
  );
  if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
  return c.json(out.value as Record<string, unknown>);
}
