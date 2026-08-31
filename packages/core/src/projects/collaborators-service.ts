/**
 * The people a caller shares projects with, and the roles they hold there.
 *
 * "Visible" is decided by the caller and passed in: MCP resolves it from a
 * principal, and nothing here needs to know which credential asked.
 */

import { and, count, eq, ilike, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectMembers, projects, users } from '../db/schema.js';

export type CollaboratorQuery = {
  visibleProjectIds: string[];
  limit: number;
  offset: number;
  search?: string | undefined;
};

export type Collaborator = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  memberships: Array<{ projectId: string; projectSlug: string; role: string }>;
};

// cm:guard the projection names its columns. `users` carries `passwordHash` and every auth secret on the same row, so a `select()` here would answer a people-search with credentials — and this tool's whole surface is other people's rows, not the caller's own.
export async function listCollaborators(
  q: CollaboratorQuery,
): Promise<{ users: Collaborator[]; total: number }> {
  if (q.visibleProjectIds.length === 0) return { users: [], total: 0 };

  const memberUserRows = await db
    .selectDistinct({ id: projectMembers.userId })
    .from(projectMembers)
    .where(inArray(projectMembers.projectId, q.visibleProjectIds));
  const candidateIds = [...new Set(memberUserRows.map((r) => r.id))];
  if (candidateIds.length === 0) return { users: [], total: 0 };

  const searchClause = q.search
    ? ilike(users.email, `${q.search.replace(/[%_]/g, '\\$&')}%`)
    : undefined;
  const whereClause = searchClause
    ? and(inArray(users.id, candidateIds), searchClause)
    : inArray(users.id, candidateIds);

  const [totalRow] = await db.select({ total: count() }).from(users).where(whereClause);
  const total = Number(totalRow?.total ?? 0);

  const userRows = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(whereClause)
    .orderBy(users.createdAt, users.id)
    .limit(q.limit)
    .offset(q.offset);

  if (userRows.length === 0) return { users: [], total };

  const ids = userRows.map((u) => u.id);
  const memberRows = await db
    .select({
      userId: projectMembers.userId,
      projectId: projectMembers.projectId,
      projectSlug: projects.slug,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        inArray(projectMembers.userId, ids),
        inArray(projectMembers.projectId, q.visibleProjectIds),
      ),
    );

  const byUser = new Map<string, Collaborator['memberships']>();
  for (const m of memberRows) {
    const list = byUser.get(m.userId) ?? [];
    list.push({ projectId: m.projectId, projectSlug: m.projectSlug, role: m.role });
    byUser.set(m.userId, list);
  }

  return {
    users: userRows.map((u) => ({ ...u, memberships: byUser.get(u.id) ?? [] })),
    total,
  };
}
