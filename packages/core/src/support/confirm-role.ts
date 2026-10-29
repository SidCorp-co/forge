// Who may confirm a change to a running system in a channel agent's group (REQ-77 BC-10): a
// confirmer the binding names, the owner under owner mode, or a member the channel record holds,
// confirmed by a person, as Technical or Maintenance. A User, a Product member, a Bot, and a role
// the bot only inferred from messages, confirm nothing: what a message says about its writer is
// data, never a grant. A support group or an operations room has none of the third: its changes
// wait on its asker or its named confirmers, as before.

import type { SupportGrants } from '@forge/contracts/support';
import {
  CHANGE_CONFIRM_ROLES,
  CHANNEL_ROLE_LABEL,
  type ChannelRole,
} from '@forge/contracts/support-channel';
import { channelOf, memberOf } from './channel-store.js';
import { isConfirmer } from './grants.js';
import type { RoomRow } from './store.js';

/** Whether a change in a channel agent's group is confirmed by what the chat server says its writer is. */
export function changeWaitsOnRole(room: Pick<RoomRow, 'kind'>): boolean {
  return room.kind === 'agent';
}

/**
 * Whether the writer, by the username and id the chat server signed, may confirm a change that
 * waits on a confirmer.
 */
export async function mayConfirmChange(
  room: RoomRow,
  grants: SupportGrants,
  writer: { key: string | null; label: string | null },
): Promise<boolean> {
  if (isConfirmer(grants, writer)) return true;
  if (!changeWaitsOnRole(room) || !writer.label) return false;
  const channel = await channelOf(room.projectId, room.rid);
  const member = channel ? await memberOf(channel.id, writer.label) : null;
  return Boolean(
    member?.state === 'confirmed' &&
      member.roles.some((r) => CHANGE_CONFIRM_ROLES.includes(r as ChannelRole)),
  );
}

/** Who can confirm, as the thread and the session are told it. */
export function whoConfirms(room: Pick<RoomRow, 'kind'>, grants: SupportGrants): string {
  const who = (grants.confirmers ?? []).map((c) => `@${c}`);
  if (grants.abilities.includes('owner_mode')) who.push('the owner');
  if (changeWaitsOnRole(room)) {
    who.push(
      `a ${CHANGE_CONFIRM_ROLES.map((r) => CHANNEL_ROLE_LABEL[r]).join(' or ')} member this channel's record confirms`,
    );
  }
  return who.join(' or ') || 'a confirmer this room names';
}
