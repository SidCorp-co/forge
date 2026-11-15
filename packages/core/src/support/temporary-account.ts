// A chat sender with no Forge account (ISS-1243 item 10, owner 2026-11-15: a temporary account, and
// nobody made to sign up): core makes a temporary account for the chat identity on its first message, so who the sender is and what they did before
// resolve for every reader, the routing signals included; nobody is asked to sign up. It is no `users`
// row (`schema-support-asks.ts:chatTemporaryAccounts`): it holds no login, password, token or grant,
// so it can never sign in, and nothing runs as it: an act that runs as the asker still resolves the
// speaker (`resolveSpeaker`) and is refused for it as for anyone unlinked. Linking it later (the link
// page, or an admin's naming) records the Forge account on it; its history is keyed on the chat
// identity, so it stays whole and reads as that account's.

import { and, eq, isNull } from 'drizzle-orm';
import { resolveSpeaker, type SpeakerLinked } from '../assistant/index.js';
import { db } from '../db/client.js';
import type { ConversationAdapter } from '../db/schema-conversations.js';
import { chatTemporaryAccounts } from '../db/schema-support-asks.js';

/** A chat identity as the room knows it: the server's account id on that server. */
export interface ChatIdentity {
  source: ConversationAdapter;
  /** The chat server instance, for Rocket.Chat its host. */
  namespace: string;
  externalId: string;
  label?: string | null | undefined;
}

/**
 * Who a sender is, for every reader of a turn: the Forge account their chat identity is linked or
 * named to, or the temporary account core made for it. A Forge account carries the temporary account
 * it was before, where it had one, so history filed under either reads as one person's.
 */
export type SenderAccount =
  | { kind: 'forge'; userId: string; temporaryAccountId: string | null; chatKey: string }
  | { kind: 'temporary'; temporaryAccountId: string; label: string | null; chatKey: string };

const identityIs = (who: ChatIdentity) =>
  and(
    eq(chatTemporaryAccounts.source, who.source),
    eq(chatTemporaryAccounts.externalNamespace, who.namespace),
    eq(chatTemporaryAccounts.externalId, who.externalId),
  );

async function temporaryOf(who: ChatIdentity) {
  const [row] = await db.select().from(chatTemporaryAccounts).where(identityIs(who)).limit(1);
  return row ?? null;
}

/**
 * The sender's account, made on first sight where none resolves: `projectId` is where a naming is
 * read (a project admin's holds only there), omitted where the act reaches past one project.
 */
export async function senderAccount(who: ChatIdentity, projectId?: string): Promise<SenderAccount> {
  const speaker = await resolveSpeaker(
    { source: who.source, namespace: who.namespace, externalId: who.externalId },
    projectId,
  );
  if (speaker.linked) {
    const before = await temporaryOf(who);
    return {
      kind: 'forge',
      userId: speaker.userId,
      temporaryAccountId: before?.id ?? null,
      chatKey: who.externalId,
    };
  }
  await db
    .insert(chatTemporaryAccounts)
    .values({
      source: who.source,
      externalNamespace: who.namespace,
      externalId: who.externalId,
      externalLabel: who.label ?? null,
    })
    .onConflictDoNothing();
  const row = await temporaryOf(who);
  if (!row) throw new Error('support: a temporary account was neither made nor found');
  return {
    kind: 'temporary',
    temporaryAccountId: row.id,
    label: row.externalLabel ?? who.label ?? null,
    chatKey: who.externalId,
  };
}

/**
 * A link or a naming confirmed the person's Forge account: their temporary account, where they had
 * one, records it. Nothing it holds moves, since its history is keyed on the chat identity.
 */
export async function linkTemporaryAccount(linked: SpeakerLinked): Promise<void> {
  await db
    .update(chatTemporaryAccounts)
    .set({ linkedUserId: linked.userId, linkedAt: new Date() })
    .where(
      and(
        eq(chatTemporaryAccounts.source, linked.source as ConversationAdapter),
        eq(chatTemporaryAccounts.externalNamespace, linked.namespace),
        eq(chatTemporaryAccounts.externalId, linked.externalId),
        isNull(chatTemporaryAccounts.linkedUserId),
      ),
    );
}
