// What a room's binding grants its session (REQ-75 r5 BC-27, BC-28). The grant is policy on the
// binding (VISION kernel-hard-policy-soft); this is the gate. An act that needs an ability the room
// does not hold, or a target or host its grant does not name, is refused here by name before
// anything runs, and the refusal says who can grant it: the project's admins, in project settings.

import {
  SUPPORT_ABILITY_MEANING,
  type SupportAbility,
  type SupportGrants,
  type SupportRoomConfig,
} from '@forge/contracts/support';
import { findBindingWithConnectionById } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import { holderNames } from '../permissions/index.js';
import { no, type Outcome } from './outcome.js';
import type { RoomRow } from './store.js';

/**
 * A room's `support` block as its binding holds it now, or a channel agent room's `agent` block (the
 * same shape, REQ-77); null for an operations room or a gone binding.
 */
export async function supportConfigOf(room: RoomRow): Promise<SupportRoomConfig | null> {
  if (room.kind === 'operations') return null;
  const pair = await findBindingWithConnectionById(room.bindingId);
  const config = (pair?.binding.config ?? null) as RocketChatBindingConfig | null;
  return (room.kind === 'agent' ? config?.agent : config?.support) ?? null;
}

const NO_GRANT: SupportGrants = { abilities: [] };

/** What the room holds; a support group whose binding names no grant holds no ability. */
export function grantsOf(config: SupportRoomConfig | null): SupportGrants {
  return config?.grants ?? NO_GRANT;
}

/** Where a grant is made, said the same way by every refusal. */
const WHERE = 'Project settings → Integrations → Rocket.Chat';

/** The people who can change a room's grant: the project's admins, by name. */
export async function granters(projectId: string): Promise<string> {
  const names = await holderNames('project.admin', projectId);
  return names.length > 0
    ? `a project admin (${names.join(', ')}) grants it in ${WHERE}`
    : `nobody holds project admin on this project, so an organization admin must first name one; a project admin then grants it in ${WHERE}`;
}

const held = (g: SupportGrants) =>
  g.abilities.length > 0
    ? `This room holds ${g.abilities.map((a) => `\`${a}\``).join(', ')}.`
    : 'This room holds no ability.';

/**
 * Null when the room may take the act: it holds `ability` and, where one is named, its grant names
 * the target or host. Otherwise the refusal naming the ability, what the room holds, and who can
 * grant it.
 */
export async function abilityRefusal(
  room: RoomRow,
  grants: SupportGrants,
  ability: SupportAbility,
  reach?: { host?: string; target?: string },
): Promise<Outcome<never> | null> {
  const meaning = SUPPORT_ABILITY_MEANING[ability];
  if (!grants.abilities.includes(ability)) {
    return no(
      'SUPPORT_ABILITY_NOT_GRANTED',
      '/action',
      `This room is not granted \`${ability}\` (${meaning}), so nothing was done. ${held(grants)} To grant it, ${await granters(room.projectId)}.`,
    );
  }
  if (reach?.host !== undefined && !(grants.hosts ?? []).includes(reach.host)) {
    return no(
      'SUPPORT_ABILITY_NOT_GRANTED',
      '/host',
      `This room may run commands on ${(grants.hosts ?? []).join(', ')}, and not on ${reach.host}, so nothing was run. To add a host, ${await granters(room.projectId)}.`,
    );
  }
  if (reach?.target !== undefined && !(grants.deployTargets ?? []).includes(reach.target)) {
    return no(
      'SUPPORT_ABILITY_NOT_GRANTED',
      '/target',
      `This room may deploy ${(grants.deployTargets ?? []).join(', ')}, and not ${reach.target}, so nothing was deployed. To add a target, ${await granters(room.projectId)}.`,
    );
  }
  return null;
}

/** Whether the account the chat server signed is the owner a channel agent's owner mode obeys (REQ-77 BC-20). */
export function isOwner(grants: SupportGrants, userId: string | null | undefined): boolean {
  return Boolean(
    userId && grants.abilities.includes('owner_mode') && grants.owner && grants.owner === userId,
  );
}

/**
 * Whether the writer may confirm a change this room's grant waits on (a build, a deploy, a host
 * change): a confirmer the grant names, by the username the server signed; or, under owner mode,
 * the owner, by the user id the server signed (REQ-77 BC-21).
 */
export function isConfirmer(
  grants: SupportGrants,
  writer: { key: string | null; label: string | null },
): boolean {
  if (isOwner(grants, writer.key)) return true;
  if (!writer.label) return false;
  const name = writer.label.toLowerCase();
  return (grants.confirmers ?? []).some((c) => c.toLowerCase() === name);
}
