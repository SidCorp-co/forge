// The room acts' capability cards (ISS-1251), one per act a room agent actually uses, declared on
// forge_support (`tool.ts`) so forge_find and forge_describe answer them, and rendered into each room
// brief's map (`room-conduct.ts`): a map line is its act's lead situation, so the card is the one
// text that teaches the act. An act with no recorded use carries no card; ISS-1251's no-use list
// says why each one does not.

import {
  type CapabilityCardBody,
  type CapabilityCardFields,
  capabilityCardSchema,
} from '@forge/contracts/capability-cards';
import type { SUPPORT_ACTIONS } from '@forge/contracts/support';
import type { OperationsAction } from '@forge/contracts/support-operations';
import { REFERENCE_ACT_CARDS } from './reference-cards.js';
import { ROOM_ACT_CARDS } from './room-cards.js';
import { WORK_ACT_CARDS } from './work-cards.js';

/** An act of forge_support: a support group's, a channel agent's, or an operations room's. */
export type SupportAction = (typeof SUPPORT_ACTIONS)[number] | OperationsAction;

export const SUPPORT_ACT_CARDS: Readonly<Partial<Record<SupportAction, CapabilityCardBody>>> = {
  ...ROOM_ACT_CARDS,
  ...WORK_ACT_CARDS,
  ...REFERENCE_ACT_CARDS,
};

/** The door a room act is served as, and its card is keyed by: `support.member`. */
export const actDoor = (act: SupportAction): string => `support.${act}`;

/** An act's card, judged whole; an act the brief names with no card is a build error, by name. */
export function actCard(act: SupportAction): CapabilityCardFields {
  const body = SUPPORT_ACT_CARDS[act];
  if (!body) {
    throw new Error(
      `support: the room brief maps ${actDoor(act)}, which carries no card (support/act-cards.ts)`,
    );
  }
  return capabilityCardSchema.parse(body);
}

const sentence = (s: string) => s.replace(/[.;]$/, '');

/**
 * The map line of an act: its card's lead situation, "- When <when>: <do>", with what to watch for
 * in it where the card says. The rest of the card is Tier 1, read with forge_describe.
 */
export function mapLine(act: SupportAction): string {
  const [lead] = actCard(act).situations;
  if (!lead) throw new Error(`support: ${actDoor(act)}'s card holds no situation`);
  return `- When ${sentence(lead.when)}: ${sentence(lead.do)}${lead.watch ? `; ${sentence(lead.watch)}` : ''}.`;
}
