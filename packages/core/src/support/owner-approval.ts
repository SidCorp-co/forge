// The product's approval gate on an owner act (ISS-1014 c2, design support-owner-acts step
// approval-gate, REQ-85 BC-6): a tool its binding declares `approval` (a key code, a destructive
// change) runs only on the owner's plain agreement. The first call naming none is refused
// SUPPORT_OWNER_APPROVAL_NEEDED and recorded on the thread as what was asked of him; the room asks
// him in its own words, and a later call cites his answer as `agreement`, which core checks is his
// own message, in that thread, written after that ask for this very act. Nothing else stands for it.

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import type { SupportCallArgs } from '../integrations/support-api/index.js';
import { memberMessage } from './channel-store.js';
import { no, type Outcome } from './outcome.js';
import { type OwnerRoom, whoCanConsent } from './owner-consent.js';
import type { RoomRow } from './store.js';

/** When the room was last told this very act needs his approval, in this thread; null where never. */
async function approvalAskedAt(
  room: RoomRow,
  input: { thread: string; tool: string; args: SupportCallArgs },
): Promise<Date | null> {
  const [row] = await db
    .select({ at: supportActions.createdAt })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.thread, input.thread),
        eq(supportActions.kind, 'refused'),
        eq(supportActions.tool, 'owner_act'),
        sql`${supportActions.output}->>'code' = 'SUPPORT_OWNER_APPROVAL_NEEDED'`,
        sql`${supportActions.input}->>'tool' = ${input.tool}`,
        sql`${supportActions.input}->'args' = ${JSON.stringify(input.args)}::jsonb`,
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/**
 * The owner's agreement an approval-gated act runs on: the cited message id, or the refusal naming
 * what is missing. Nothing is sent to the product on a refusal.
 */
export async function approvalOf(
  room: RoomRow,
  at: OwnerRoom,
  input: { thread: string; tool: string; args: SupportCallArgs; agreement?: string | undefined },
): Promise<Outcome<string>> {
  const asked = await approvalAskedAt(room, input);
  const askHim = `${input.tool} is an act the product gates on its owner's approval, so it runs only on his plain agreement: ask him in this thread, in your own words, what it will do, then call owner_act again with the same tool and args and his answer's message id as \`agreement\`. Nothing was sent`;
  if (!input.agreement) return no('SUPPORT_OWNER_APPROVAL_NEEDED', '/agreement', askHim);
  const said = await memberMessage(room.id, input.agreement);
  if (!said || said.thread !== input.thread) {
    return no(
      'SUPPORT_MESSAGE_UNKNOWN',
      '/agreement',
      `${input.agreement} is ${said ? `in thread ${said.thread}, not ${input.thread}` : "no member's message this room received"}: cite the owner's own answer in this thread. Nothing was sent`,
    );
  }
  if (said.authorKey !== at.owner) {
    return no(
      'SUPPORT_OWNER_APPROVAL_NOT_HIS',
      '/agreement',
      `@${said.author ?? said.authorKey} wrote ${input.agreement}, and only the owner's own word approves an act the product gates; ${await whoCanConsent(room, at)}. Nothing was sent`,
    );
  }
  if (!asked || said.at <= asked) {
    return no(
      'SUPPORT_OWNER_APPROVAL_NEEDED',
      '/agreement',
      `${input.agreement} was written ${asked ? 'before he was asked to approve this act' : 'with no ask for this act standing in the thread'}, so it is not his agreement to it. ${askHim}`,
    );
  }
  return { ok: true, value: input.agreement };
}
