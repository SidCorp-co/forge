/**
 * One-time migration: backfill isAI on activity records from their source comments,
 * and create missing activity records for comments that have none.
 */
export async function backfillCommentActivities(strapi: any) {
  const db = strapi.db;

  // 1. Fix existing comment activities: sync isAI from the comment table
  const updated = await db.connection.raw(`
    UPDATE activities
    SET is_ai = 1
    WHERE type = 'comment'
      AND is_ai = 0
      AND body IN (
        SELECT c.body FROM comments c WHERE c.is_ai = 1
      )
  `).catch(() => null);

  const updatedCount = updated?.changes ?? updated?.rowCount ?? 0;
  if (updatedCount > 0) {
    strapi.log.info(`[migration] Backfilled isAI on ${updatedCount} comment activities`);
  }

  // 2. Find comments that have no corresponding activity record and create them
  const orphanComments = await db.connection.raw(`
    SELECT c.id, c.document_id, c.body, c.author, c.is_ai, c.created_at,
           cl.issue_id
    FROM comments c
    JOIN comments_issue_lnk cl ON cl.comment_id = c.id
    WHERE NOT EXISTS (
      SELECT 1 FROM activities a
      JOIN activities_issue_lnk al ON al.activity_id = a.id
      WHERE a.type = 'comment'
        AND a.body = c.body
        AND al.issue_id = cl.issue_id
    )
  `).catch(() => ({ rows: [] }));

  const rows = orphanComments?.rows ?? orphanComments ?? [];
  if (!Array.isArray(rows) || rows.length === 0) return;

  // Resolve issue documentIds
  const issueIds = [...new Set(rows.map((r: any) => r.issue_id))];
  const issues = await db.connection.raw(
    `SELECT id, document_id FROM issues WHERE id IN (${issueIds.map(() => '?').join(',')})`,
    issueIds,
  ).catch(() => ({ rows: [] }));
  const issueMap = new Map((issues?.rows ?? issues ?? []).map((i: any) => [i.id, i.document_id]));

  const { createActivity } = require('../../lifecycles/issue-lifecycle');
  let created = 0;
  for (const row of rows) {
    const issueDocId = issueMap.get(row.issue_id);
    if (!issueDocId) continue;
    await createActivity(strapi, {
      type: 'comment',
      issue: issueDocId,
      actor: row.author || 'system',
      body: row.body,
      isAI: !!row.is_ai,
    });
    created++;
  }

  if (created > 0) {
    strapi.log.info(`[migration] Created ${created} missing comment activity records`);
  }

  // 3. Backfill attachment metadata on existing comment activities
  await backfillCommentAttachments(strapi);
}

/**
 * Backfill attachment data into activity metadata for comment activities
 * whose source comments have attachments but the activity metadata doesn't.
 */
async function backfillCommentAttachments(strapi: any) {
  const COMMENT_UID = 'api::comment.comment' as const;
  const ACTIVITY_UID = 'api::activity.activity' as const;

  // Find all comments that have attachments
  const comments = await strapi.documents(COMMENT_UID).findMany({
    populate: ['attachments', 'issue'],
    limit: 500,
  });
  const commentsWithAttachments = comments.filter(
    (c: any) => c.attachments?.length > 0 && c.issue?.documentId,
  );

  if (commentsWithAttachments.length === 0) return;

  // Find all comment activities (use documents API for proper relation resolution)
  const activities = await strapi.documents(ACTIVITY_UID).findMany({
    filters: { type: 'comment' },
    populate: ['issue'],
    limit: 500,
  });

  let patched = 0;
  for (const comment of commentsWithAttachments) {
    const attachmentData = comment.attachments.map((a: any) => ({
      id: a.id, url: a.url, name: a.name, mime: a.mime,
    }));

    // Find matching activity — by commentDocumentId in metadata, or by body match
    const match = activities.find((act: any) => {
      const meta = act.metadata as Record<string, any> | null;
      // Already has attachments — skip
      if (meta?.attachments?.length) return false;
      // Match by commentDocumentId
      if (meta?.commentDocumentId === comment.documentId) return true;
      // Fallback: match by body text + issue
      if (act.body === comment.body && act.issue?.documentId === comment.issue.documentId) return true;
      return false;
    });

    if (!match) continue;

    const existingMeta = (match.metadata as Record<string, any>) || {};
    const updatedMeta = {
      ...existingMeta,
      commentDocumentId: comment.documentId,
      attachments: attachmentData,
    };

    await strapi.documents(ACTIVITY_UID).update({
      documentId: match.documentId,
      data: { metadata: updatedMeta } as any,
    });
    patched++;
  }

  if (patched > 0) {
    strapi.log.info(`[migration] Backfilled attachments on ${patched} comment activities`);
  }
}
