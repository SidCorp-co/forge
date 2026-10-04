import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';

export interface Person {
  name: string;
  kind: 'human' | 'agent';
}

/** The name a user set, else the part of their address before the `@`; never the whole address. */
export function personLabel(u: { displayName: string | null; email: string }): string {
  return u.displayName?.trim() || (u.email.split('@')[0] ?? u.email);
}

export async function peopleOf(ids: readonly (string | null)[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids.filter((i): i is string => i !== null))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email, kind: users.kind })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((u) => [u.id, { name: personLabel(u), kind: u.kind }]));
}

export async function userNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  return new Map([...(await peopleOf(ids))].map(([id, p]) => [id, p.name]));
}
