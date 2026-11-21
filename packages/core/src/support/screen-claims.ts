// What a room's reply is marked with on its own row (ISS-1356): the claim it makes about what a screen
// shows, with the looks its turn took (so the record shows which UI claims carried a shot), and a
// correction of an earlier post (so the room's day counts them per turn). Read off the posted words
// by the forms `reply-audit/code-lines.ts` holds; nothing here holds or rewrites a post.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { correctionIn, screenClaimIn } from './reply-audit/code-lines.js';

/** What a reply's row carries beside its words: its screen claim and its turn's looks, its correction. */
export interface ReplyMarks {
  screen?: { claim: string; looks: string[] };
  correction?: string;
}

/** The boxes the turn looked at a screen in, oldest first. */
async function looksInTurn(turn: string): Promise<string[]> {
  const rows = await db
    .select({ box: sql<string | null>`${supportActions.input}->>'box'` })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.turnId, turn),
        eq(supportActions.kind, 'operation'),
        eq(supportActions.tool, 'look'),
      ),
    )
    .orderBy(supportActions.createdAt);
  return [...new Set(rows.flatMap((r) => (r.box ? [r.box] : [])))];
}

/** The marks a reply's row carries, or null where its words make no screen claim and no correction. */
export async function replyMarksOf(
  text: string,
  turn: string | null | undefined,
): Promise<ReplyMarks | null> {
  const claim = screenClaimIn(text);
  const correction = correctionIn(text);
  if (!claim && !correction) return null;
  return {
    ...(claim ? { screen: { claim, looks: turn ? await looksInTurn(turn) : [] } } : {}),
    ...(correction ? { correction } : {}),
  };
}
