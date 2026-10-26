// An operations room's bot and what it may do (REQ-75 BC-22..BC-24). The role is data on the bot's
// `rocketchat` connection, one per account: a persona, the grants, and a name the refusals use. An
// act the role is not granted is refused here, by the grant it lacks, before anything is read or
// written — so a bot that coordinates delivery never drafts product direction, and one that drafts
// it never moves delivery, whatever its session is asked.

import {
  type ChatRole,
  chatRoleSchema,
  OPERATIONS_ACTION_GRANT,
  OPERATIONS_GRANT_MEANING,
  type OperationsAction,
  type OperationsGrant,
} from '@forge/contracts/support-operations';
import { findBindingWithConnectionById } from '../integrations/index.js';
import type { Outcome } from './outcome.js';
import { no } from './outcome.js';
import type { RoomRow } from './store.js';

/** What a role lacking each grant is told it leaves to others. */
const LEFT_TO: Record<OperationsGrant, string> = {
  read: 'nothing here can be read for it',
  deliver:
    "delivery is moved by a role granted `deliver`, with the asking member's own permissions",
  draft:
    'product direction is drafted by a role granted `draft` and decided by a person, never by this role',
  research: 'web research belongs to a role granted `research`',
};

/** The role the room's bot answers under, or the refusal naming why it has none. */
export async function roleOfRoom(room: RoomRow): Promise<Outcome<ChatRole>> {
  const pair = await findBindingWithConnectionById(room.bindingId);
  const held = (pair?.connection.config as { role?: unknown } | null | undefined)?.role;
  const parsed = chatRoleSchema.safeParse(held);
  if (parsed.success) return { ok: true, value: parsed.data };
  return no(
    'OPS_NO_ROLE',
    '',
    held === undefined
      ? "this operations room's bot account carries no role; set `role` { name, persona, grants } on its rocketchat connection"
      : `this operations room's bot account carries a role Forge cannot read (${parsed.error.issues[0]?.message ?? 'invalid'}); rewrite \`role\` on its rocketchat connection`,
  );
}

/** Null when the role is granted what `action` needs; else the refusal naming the grant. */
export function grantRefusal(role: ChatRole, action: OperationsAction): Outcome<never> | null {
  const grant = OPERATIONS_ACTION_GRANT[action];
  if (role.grants.includes(grant)) return null;
  return no(
    'OPS_ROLE_NOT_GRANTED',
    '/action',
    `the ${role.name} role is not granted \`${grant}\` (${OPERATIONS_GRANT_MEANING[grant]}), so ${action} is refused here: ${LEFT_TO[grant]}. This role holds ${role.grants.map((g) => `\`${g}\``).join(', ')}.`,
  );
}
