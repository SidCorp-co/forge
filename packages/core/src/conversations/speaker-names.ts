// A person's message stores no name: it is read from their row each time it is shown (ISS-1229 r25),
// and a transport handle it could not link stays the label.

import { and, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversationMessages } from '../db/schema-conversations.js';
import { userLabels } from '../issues/actor-resolution.js';
import { personName, personNameSql } from '../lib/person-name.js';

interface Spoken {
  role: string;
  authorUserId: string | null;
  authorLabel: string | null;
}

/** Each person's message named by its author's current name; every other message as it was. */
export async function nameSpeakers<T extends Spoken>(messages: readonly T[]): Promise<T[]> {
  const ids = [...new Set(messages.flatMap((m) => (spokenByAPerson(m) ? [m.authorUserId] : [])))];
  const names = await userLabels(ids, 'start');
  return messages.map((m) => ({ ...m, authorLabel: speakerOf(m, names) }));
}

/** What everyone who has spoken in this room is called now, for a reader that names them later. */
export async function roomSpeakerNames(conversationId: string): Promise<Map<string, string>> {
  const rows = await db
    .selectDistinct({ id: conversationMessages.authorUserId })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.role, 'user'),
        isNotNull(conversationMessages.authorUserId),
      ),
    );
  return userLabels(
    rows.flatMap((r) => (r.id ? [r.id] : [])),
    'start',
  );
}

/** One message's speaker out of names already read: a person by their name, else the stored label. */
export function speakerOf(m: Spoken, names: ReadonlyMap<string, string>): string | null {
  return spokenByAPerson(m)
    ? (names.get(m.authorUserId) ?? personName(null, 'start'))
    : m.authorLabel;
}

const spokenByAPerson = (m: Spoken): m is Spoken & { authorUserId: string } =>
  m.role === 'user' && m.authorUserId !== null;

/** The same name in SQL, for a reader that selects messages itself rather than handing rows here. */
export function speakerNameSql(): SQL<string | null> {
  const named = personNameSql(sql`u.display_name`, 'start');
  return sql<
    string | null
  >`(CASE WHEN ${conversationMessages.role} = 'user' AND ${conversationMessages.authorUserId} IS NOT NULL
    THEN coalesce((SELECT ${named} FROM users u WHERE u.id = ${conversationMessages.authorUserId}), ${personName(null, 'start')})
    ELSE ${conversationMessages.authorLabel} END)`;
}
