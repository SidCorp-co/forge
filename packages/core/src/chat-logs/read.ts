import { and, count, desc, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { chatLogs, projects, type qaRatings } from '../db/schema.js';

export type ChatLogRow = typeof chatLogs.$inferSelect;

export type ChatLogFilters = {
  projectSlugs: string[] | null;
  source?: string | undefined;
  qaRating?: (typeof qaRatings)[number] | undefined;
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
};

/** The slugs of these projects. */
export async function projectSlugsOf(projectIds: string[]): Promise<string[]> {
  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  return rows.map((r) => r.slug);
}

/** One page of chat logs, newest first, with the filtered total, scoped to one slug or a slug list. */
export async function listChatLogs(
  filters: ChatLogFilters & { projectSlug?: string | undefined },
  page: { limit: number; offset: number },
): Promise<{ rows: ChatLogRow[]; total: number }> {
  const conditions: SQL[] = [];
  if (filters.projectSlug) conditions.push(eq(chatLogs.projectSlug, filters.projectSlug));
  if (filters.projectSlugs) conditions.push(inArray(chatLogs.projectSlug, filters.projectSlugs));
  if (filters.source) conditions.push(eq(chatLogs.source, filters.source));
  if (filters.qaRating) conditions.push(eq(chatLogs.qaRating, filters.qaRating));
  if (filters.dateFrom) conditions.push(gte(chatLogs.createdAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(chatLogs.createdAt, filters.dateTo));

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(chatLogs)
      .where(and(...conditions))
      .orderBy(desc(chatLogs.createdAt))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ n: count() })
      .from(chatLogs)
      .where(and(...conditions)),
  ]);
  return { rows, total: totalRow?.n ?? 0 };
}

/** A project's newest chat logs. */
export async function recentChatLogs(projectSlug: string, limit: number): Promise<ChatLogRow[]> {
  return db
    .select()
    .from(chatLogs)
    .where(eq(chatLogs.projectSlug, projectSlug))
    .orderBy(desc(chatLogs.createdAt))
    .limit(limit);
}

/** A project's newest chat logs rated bad or flagged. */
export async function flaggedChatLogs(projectSlug: string, limit: number): Promise<ChatLogRow[]> {
  return db
    .select()
    .from(chatLogs)
    .where(
      and(eq(chatLogs.projectSlug, projectSlug), inArray(chatLogs.qaRating, ['bad', 'flagged'])),
    )
    .orderBy(desc(chatLogs.createdAt))
    .limit(limit);
}

/** One chat log by id, or null. */
export async function chatLogById(id: string): Promise<ChatLogRow | null> {
  const [row] = await db.select().from(chatLogs).where(eq(chatLogs.id, id)).limit(1);
  return row ?? null;
}
