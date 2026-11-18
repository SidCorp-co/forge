// The owner's ecosystem membership acts, made from his word in chat (ISS-1299: the room promised him
// an ecosystem link no door let it make): the steward's invite and the member project's accept,
// decline and leave, each through its own service as him (`ecosystem/membership-acts.ts`).

import type { SupportForgeActRequest } from '@forge/contracts/support-channel';
import { type MembershipAct, membershipActByName } from '../ecosystem/index.js';
import type { OpsOutcome } from './ops-types.js';

/** The ecosystem membership acts (ISS-1299), each the verb its own service takes. */
const MEMBERSHIP: Readonly<Record<string, MembershipAct>> = {
  'membership.invite': 'invite',
  'membership.accept': 'accept',
  'membership.decline': 'decline',
  'membership.leave': 'leave',
};
/** How long a membership's leave reason may be, as its route takes it. */
const LEAVE_REASON_MAX = 500;

/** Whether `act` is one of the membership acts. */
export const isMembershipAct = (act: string): boolean => Object.hasOwn(MEMBERSHIP, act);

/** An ecosystem membership act, as its own service makes it for him (ISS-1299). */
export async function membershipAct(
  input: SupportForgeActRequest,
  reason: string | undefined,
  at: { projectId: string; projectSlug: string; userId: string },
): Promise<OpsOutcome<{ key: string; recorded: string }>> {
  const verb = MEMBERSHIP[input.act] as MembershipAct;
  const made = await membershipActByName({
    act: verb,
    ecosystem: input.item,
    projectId: at.projectId,
    projectSlug: at.projectSlug,
    userId: at.userId,
    reason: reason ? quotedTo(reason, LEAVE_REASON_MAX) : null,
  });
  if (!made.ok) return { ok: false, refusals: made.refusals };
  return {
    ok: true,
    value: {
      key: input.item,
      recorded: `${at.projectSlug} in ${input.item}: membership ${made.membership.id}, ${made.membership.state}`,
    },
  };
}

const quotedTo = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
