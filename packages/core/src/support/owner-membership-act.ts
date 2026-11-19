// The owner's ecosystem membership acts, made from his word in chat (ISS-1299: the room promised him
// an ecosystem link no door let it make): the steward's invite and the member project's accept,
// decline and leave, each through its own service as him (`ecosystem/membership-acts.ts`).

import { REASON_LINE_MAX } from '@forge/contracts/comments';
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
    // a leave keeps his own why (`reason` in the request): the room's citation of his message alone
    // is no why, so a leave without one is refused MEMBERSHIP_REASON_REQUIRED by its service
    reason: input.reason && reason ? quotedTo(reason, REASON_LINE_MAX) : null,
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
