/**
 * One-time migration: backfill inverse relations so every existing one-way
 * relation gets a matching inverse on the target issue.
 */

const INVERSE_TYPE: Record<string, string> = {
  related_to: 'related_to',
  blocked_by: 'blocks',
  blocks: 'blocked_by',
  depends_on: 'depended_on_by',
  depended_on_by: 'depends_on',
  caused_by: 'caused_by',
  duplicate_of: 'duplicate_of',
  fixed_by: 'fixed_by',
};

const ISSUE_UID = 'api::issue.issue' as any;

export async function backfillInverseRelations(strapi: any) {
  const allIssues = await strapi.documents(ISSUE_UID).findMany({
    fields: ['documentId', 'relations'],
    limit: -1,
  });

  // Build a map of documentId -> relations for quick lookup
  const issueMap = new Map<string, any>(allIssues.map((i: any) => [i.documentId, i]));

  let totalAdded = 0;
  const toUpdate = new Map<string, any[]>(); // documentId -> patched relations

  for (const issue of allIssues) {
    const relations: any[] = Array.isArray(issue.relations) ? issue.relations : [];
    if (relations.length === 0) continue;

    for (const rel of relations) {
      const targetDocId = rel.targetDocumentId;
      if (!targetDocId) continue;

      const target = issueMap.get(targetDocId);
      if (!target) continue;

      // Get the current (possibly already patched) relations for the target
      const targetRels: any[] = toUpdate.get(targetDocId)
        ?? (Array.isArray(target.relations) ? [...target.relations] : []);

      // Check if inverse already exists
      if (targetRels.some((r: any) => r.targetDocumentId === issue.documentId)) continue;

      const inverseType = INVERSE_TYPE[rel.type] || 'related_to';
      targetRels.push({
        type: inverseType,
        targetDocumentId: issue.documentId,
        reason: rel.reason || 'Backfilled inverse relation',
      });

      toUpdate.set(targetDocId, targetRels);
      totalAdded++;
    }
  }

  // Persist all updates
  for (const [documentId, relations] of toUpdate) {
    await strapi.documents(ISSUE_UID).update({
      documentId,
      data: { relations },
    });
  }

  if (totalAdded > 0) {
    strapi.log.info(`[migration] Backfilled ${totalAdded} inverse relation(s) across ${toUpdate.size} issue(s)`);
  }
}
