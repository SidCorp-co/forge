// The only lines core says in a chat room on its own (ISS-875, owner 2026-11-02): the three cases
// where the agent cannot speak — no box runs it, its turn failed, or the person is past the room's
// message limit. Every other silence is the agent's to break, so core never stands in for an
// answer the agent could give. Each line is plain Vietnamese with no internal code, and a thread
// is told at most once while it waits, whichever of the three it would be: the claim is a row, so a
// restart does not tell the thread again. A door whose agent later answers the thread gives the
// claim back (`releaseLastResort`), so a later wait in it is told again (ISS-977).

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversationLastResorts } from '../db/schema-conversations.js';

export type LastResortKind = 'offline' | 'turn_failed' | 'rate_limited';

export const LAST_RESORT_LINES: Readonly<Record<LastResortKind, string>> = {
  offline:
    'Trợ lý hiện chưa hoạt động. Tin nhắn của bạn đã được ghi lại và sẽ được trả lời ngay khi trợ lý hoạt động trở lại.', // i18n-allow: core's last-resort chat line, Vietnamese by owner ruling (ISS-875)
  turn_failed:
    'Trợ lý gặp sự cố nên chưa trả lời được tin nhắn này. Bạn vui lòng gửi lại sau ít phút nhé.', // i18n-allow: core's last-resort chat line, Vietnamese by owner ruling (ISS-875)
  rate_limited:
    'Bạn đã gửi khá nhiều tin nhắn trong một giờ qua. Bạn vui lòng đợi một lát nhé, các tin nhắn của bạn vẫn được ghi lại.', // i18n-allow: core's last-resort chat line, Vietnamese by owner ruling (ISS-875)
};

/**
 * A support thread's `turn_failed` line (ISS-977): core holds the message and its own retries ran
 * out, so the line says the assistant answers when it can and never asks the person to send it
 * again. The other doors' turns are not handed again, so their `turn_failed` line stands.
 */
export const STILL_QUEUED_LINE =
  'Trợ lý đang gặp sự cố nên chưa trả lời được ngay. Tin nhắn của bạn vẫn được giữ lại, trợ lý sẽ trả lời ngay khi có thể.'; // i18n-allow: core's last-resort chat line, Vietnamese by owner ruling (ISS-875, ISS-977)

/**
 * The thread a line goes into, as its chat server knows it: the adapter, and that adapter's venue
 * id for the thread itself (a Rocket.Chat thread is `<namespace> <rid> <tmid>`, the same id a
 * support thread and an assistant's thread venue carry), so both doors into one thread share its
 * one line.
 */
export interface LastResortPlace {
  adapter: string;
  venue: string;
}

/**
 * Claim the thread's one last-resort line: the line to post (`line`, the kind's own by default), or
 * null where the thread was already told one. Claimed before it is posted, so two paths racing to
 * tell the same thread post once.
 */
export async function claimLastResort(
  place: LastResortPlace,
  kind: LastResortKind,
  line: string = LAST_RESORT_LINES[kind],
): Promise<string | null> {
  const rows = await db
    .insert(conversationLastResorts)
    .values({ adapter: place.adapter, venue: place.venue, kind })
    .onConflictDoNothing()
    .returning({ kind: conversationLastResorts.kind });
  return rows.length > 0 ? line : null;
}

/**
 * Give a thread's claim back: its line could not be posted, or the agent has since answered in it,
 * so a later case may tell the thread again.
 */
export async function releaseLastResort(place: LastResortPlace): Promise<void> {
  await db
    .delete(conversationLastResorts)
    .where(
      and(
        eq(conversationLastResorts.adapter, place.adapter),
        eq(conversationLastResorts.venue, place.venue),
      ),
    );
}
