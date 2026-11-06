// Who may confirm a change to a running system in a channel agent's group (REQ-77 BC-10): a
// confirmer the binding names, the owner under owner mode, or a member the channel record holds,
// confirmed by a person, as Technical or Maintenance. A User, a Product member, a Bot, and a role
// the bot only inferred from messages, confirm nothing: what a message says about its writer is
// data, never a grant. A support group or an operations room has none of the third: its changes
// wait on its asker or its named confirmers, as before.

import type { SupportGrants, SupportProposalKind } from '@forge/contracts/support';
import {
  CHANGE_CONFIRM_ROLES,
  CHANNEL_ROLE_LABEL,
  type ChannelRole,
} from '@forge/contracts/support-channel';
import { channelOf, memberOf } from './channel-store.js';
import { type DeciderRuleFound, deciderRuleFor } from './deciders.js';
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

/** Why an asker's own request is their consent: the room lets them confirm, or a rule names them decider. */
export type RequestConsent = { by: 'confirmer' } | ({ by: 'decider' } & DeciderRuleFound);

/**
 * Whether an asker's own request is their consent to the change it asked for, whenever it was
 * written (ISS-915, ISS-953): the room already lets that writer confirm — the owner under owner
 * mode, a confirmer the binding names, or a member the channel record confirms in a confirm role —
 * or a standing channel rule names them the one who decides that act (ISS-1000). Who that is stays
 * data on the binding and the record; a role the bot only inferred is no grant. Null otherwise.
 */
export async function requestIsConsent(
  room: RoomRow,
  grants: SupportGrants,
  asker: { key: string | null; label: string | null },
  act: SupportProposalKind,
): Promise<RequestConsent | null> {
  if (await mayConfirmChange(room, grants, asker)) return { by: 'confirmer' };
  const rule = await deciderRuleFor(room, act, asker);
  return rule ? { by: 'decider', ...rule } : null;
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

/** Who else's own request is their agreement, as a refusal teaches it (ISS-1000). */
export const DECIDER_WORDS =
  'the member a channel rule of the owner or of a confirmed Technical or Maintenance member names as the one who decides it';
