import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectMembers, projects, users } from '../db/schema.js';

export { parseMentions } from './parse-mentions.js';

export interface ResolvedMention {
  userId: string;
  email: string;
  handle: string;
}

/**
 * Resolve `@handle` strings to user IDs by matching the email local-part of
 * users who are members (or owner) of the given project. Unknown handles are
 * silently dropped — POST /comments uses this so a typo never blocks a post.
 *
 * Membership cardinality is bounded (project members + 1 owner), so we pull
 * the candidate set into JS and match on the local-part there. That avoids
 * a portability fight with `LOWER(SPLIT_PART(email, '@', 1))` across
 * Drizzle's SQL builder.
 */
export async function resolveMentions(
  handles: string[],
  projectId: string,
): Promise<ResolvedMention[]> {
  if (handles.length === 0) return [];

  const memberRows = await db
    .select({ id: users.id, email: users.email })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));

  const ownerRows = await db
    .select({ id: users.id, email: users.email })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.ownerId))
    .where(eq(projects.id, projectId))
    .limit(1);

  const uniqUsers = new Map<string, { id: string; email: string }>();
  for (const row of [...memberRows, ...ownerRows]) {
    if (!uniqUsers.has(row.id)) uniqUsers.set(row.id, row);
  }

  const wanted = new Set(handles.map((h) => h.toLowerCase()));
  const resolved: ResolvedMention[] = [];
  for (const u of uniqUsers.values()) {
    const localPart = u.email.split('@', 1)[0]?.toLowerCase();
    if (!localPart) continue;
    if (wanted.has(localPart)) {
      resolved.push({ userId: u.id, email: u.email, handle: localPart });
    }
  }
  return resolved;
}

/**
 * Test-only: bulk-resolve a set of user IDs by id. Kept here so the test
 * suite doesn't need to reach into schema internals.
 */
export async function loadUsersByIds(
  userIds: string[],
): Promise<Array<{ id: string; email: string }>> {
  if (userIds.length === 0) return [];
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, userIds));
}
