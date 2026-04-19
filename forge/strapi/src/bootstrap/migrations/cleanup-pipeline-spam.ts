/**
 * One-time migration: delete duplicate pipeline spam comments and activities.
 * Keeps the newest per issue, deletes the rest.
 * Safe to re-run — exits early if no spam found.
 */

const COMMENT_UID = 'api::comment.comment' as any;
const ACTIVITY_UID = 'api::activity.activity' as any;

async function deduplicateByIssue(strapi: any, uid: string, filters: any, label: string): Promise<number> {
  const all = await strapi.db.query(uid).findMany({
    where: filters,
    orderBy: { createdAt: 'desc' },
    select: ['id', 'documentId'],
    populate: { issue: { select: ['documentId'] } },
    limit: 50000,
  });

  if (all.length <= 1) return 0;

  // Group by issue, keep newest (first in desc order)
  const byIssue = new Map<string, any[]>();
  for (const item of all) {
    const key = item.issue?.documentId || 'none';
    if (!byIssue.has(key)) byIssue.set(key, []);
    byIssue.get(key)!.push(item);
  }

  const toDelete: number[] = [];
  for (const items of byIssue.values()) {
    for (let i = 1; i < items.length; i++) {
      toDelete.push(items[i].id);
    }
  }

  if (toDelete.length === 0) return 0;

  // Batch delete via knex for speed
  const knex = strapi.db.connection;
  const tableName = uid === COMMENT_UID ? 'comments' : 'activities';

  for (let i = 0; i < toDelete.length; i += 500) {
    const batch = toDelete.slice(i, i + 500);
    await knex(tableName).whereIn('id', batch).del();
  }

  strapi.log.info(`[cleanup-spam] ${label}: deleted ${toDelete.length}/${all.length} (kept ${all.length - toDelete.length})`);
  return toDelete.length;
}

export async function cleanupPipelineSpam(strapi: any): Promise<void> {
  let total = 0;

  // 1. "Pipeline stopped" comments from pipeline actor
  total += await deduplicateByIssue(strapi, COMMENT_UID, {
    author: 'pipeline',
    body: { $contains: 'Pipeline stopped' },
  }, 'Pipeline stopped comments');

  // 2. "Pipeline step failed" comments from Pikachu
  total += await deduplicateByIssue(strapi, COMMENT_UID, {
    author: 'Pikachu',
    body: { $contains: 'Pipeline step' },
  }, 'Pikachu step-failed comments');

  // 3. "Pipeline stopped" activities from pipeline actor
  total += await deduplicateByIssue(strapi, ACTIVITY_UID, {
    actor: 'pipeline',
    body: { $contains: 'Pipeline stopped' },
  }, 'Pipeline stopped activities');

  // 4. "Pipeline step failed" activities from Pikachu
  total += await deduplicateByIssue(strapi, ACTIVITY_UID, {
    actor: 'Pikachu',
    body: { $contains: 'Pipeline step' },
  }, 'Pikachu step-failed activities');

  if (total > 0) {
    strapi.log.info(`[cleanup-spam] Total cleaned: ${total} records`);
  }
}
