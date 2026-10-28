// A chat account linked to a Forge user by a one-time code (REQ-75 r5): the user, signed in to
// Forge, mints a code for a project; written in a Rocket.Chat room bound to that project from the
// account to link, it confirms the link, because the chat server signs who wrote the message. No
// address is read from the chat server, which needs its admin-only `view-full-other-user-info`.
// This is the account-linking shape bots use where the directory is closed (Slack's and Discord's
// "/link <code>", the device flow): proof of the Forge side by sign-in, of the chat side by who posts.
//
// Only the code's hash is kept. A code is spent once, so one a room member saw links nobody else,
// and lapses after LINK_CODE_TTL_MS.

import { createHash, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { ConversationAdapter } from '../../db/schema-conversations.js';
import { assistantSpeakerLinks, speakerLinkCodes } from '../../db/schema-speaker-links.js';

export const LINK_CODE_TTL_MS = 15 * 60_000;
/** No 0/O, 1/I: a code is read off one screen and typed into another. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 8;

/** `link <CODE>`, alone on its line, as a member writes it in the room. */
const LINK_LINE = /^\s*link\s+([A-Za-z0-9]{8})\s*$/i;

const hashOf = (code: string) => createHash('sha256').update(code.toUpperCase()).digest('hex');

/** The code a message carries to link its writer, or null when it is not a link line. */
export function linkCodeIn(text: string): string | null {
  return LINK_LINE.exec(text)?.[1]?.toUpperCase() ?? null;
}

/** A fresh code for `userId` to link an account of `source` through a room bound to `projectId`. */
export async function mintSpeakerLinkCode(input: {
  userId: string;
  projectId: string;
  source: ConversationAdapter;
}): Promise<{ code: string; expiresAt: Date }> {
  const code = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await db.insert(speakerLinkCodes).values({
    codeHash: hashOf(code),
    userId: input.userId,
    projectId: input.projectId,
    source: input.source,
    expiresAt,
  });
  return { code, expiresAt };
}

export type LinkRedeemed =
  | { ok: true; userId: string; already: boolean }
  | { ok: false; why: 'unknown' | 'linked-to-another' };

/**
 * Spend `code` for the account that wrote it: the link from that account to the user who minted
 * the code, confirmed. A code that is unknown, spent, lapsed, of another project or another channel
 * links nothing; nor does one for an account already linked to someone else.
 */
export async function redeemSpeakerLinkCode(input: {
  code: string;
  projectId: string;
  source: ConversationAdapter;
  namespace: string;
  externalId: string;
  label: string | null;
}): Promise<LinkRedeemed> {
  return db.transaction(async (tx) => {
    const [spent] = await tx
      .update(speakerLinkCodes)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(speakerLinkCodes.codeHash, hashOf(input.code)),
          eq(speakerLinkCodes.projectId, input.projectId),
          eq(speakerLinkCodes.source, input.source),
          isNull(speakerLinkCodes.usedAt),
          gt(speakerLinkCodes.expiresAt, sql`now()`),
        ),
      )
      .returning({ userId: speakerLinkCodes.userId });
    if (!spent) return { ok: false, why: 'unknown' } as const;
    const [linked] = await tx
      .insert(assistantSpeakerLinks)
      .values({
        source: input.source,
        externalNamespace: input.namespace,
        externalId: input.externalId,
        externalLabel: input.label,
        userId: spent.userId,
        confirmedVia: 'chat_code',
      })
      .onConflictDoNothing()
      .returning({ userId: assistantSpeakerLinks.userId });
    if (linked) return { ok: true, userId: linked.userId, already: false } as const;
    const [held] = await tx
      .select({ userId: assistantSpeakerLinks.userId })
      .from(assistantSpeakerLinks)
      .where(
        and(
          eq(assistantSpeakerLinks.source, input.source),
          eq(assistantSpeakerLinks.externalNamespace, input.namespace),
          eq(assistantSpeakerLinks.externalId, input.externalId),
        ),
      )
      .limit(1);
    if (held?.userId === spent.userId)
      return { ok: true, userId: spent.userId, already: true } as const;
    return { ok: false, why: 'linked-to-another' } as const;
  });
}
