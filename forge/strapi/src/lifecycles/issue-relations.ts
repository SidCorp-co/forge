import { onStatusChange as triggerPipelineStep } from '../services/pipeline-orchestrator';
import { DONE_ENOUGH_STATUSES, DECOMP_CHILD_READY_STATUSES } from '../services/pipeline-utils';

const ISSUE_UID = 'api::issue.issue' as any;
const COMMENT_UID = 'api::comment.comment' as any;
const ISS_PATTERN = /ISS-(\d+)/g;

/** Map each relation type to its inverse for bidirectional sync. */
const INVERSE_TYPE: Record<string, string> = {
  related_to: 'related_to',
  blocked_by: 'blocks',
  blocks: 'blocked_by',
  depends_on: 'depended_on_by',
  depended_on_by: 'depends_on',
};

/**
 * Sync inverse relations on target issues when relations change on the source.
 * - Added relations: ensure the target has the inverse pointing back.
 * - Removed relations: remove the inverse from the target.
 *
 * Must be called with the previous and current relations arrays.
 */
export async function syncInverseRelations(
  strapi: any,
  sourceDocumentId: string,
  prevRelations: any[],
  newRelations: any[],
): Promise<void> {
  const prevByTarget = new Map(prevRelations.map((r: any) => [r.targetDocumentId, r]));
  const newByTarget = new Map(newRelations.map((r: any) => [r.targetDocumentId, r]));

  // Relations added
  const added = newRelations.filter((r: any) => !prevByTarget.has(r.targetDocumentId));
  // Relations removed
  const removed = prevRelations.filter((r: any) => !newByTarget.has(r.targetDocumentId));

  for (const rel of added) {
    const inverseType = INVERSE_TYPE[rel.type] || 'related_to';
    await addInverseRelation(strapi, rel.targetDocumentId, sourceDocumentId, inverseType, rel.reason);
  }

  for (const rel of removed) {
    await removeInverseRelation(strapi, rel.targetDocumentId, sourceDocumentId);
  }
}

async function addInverseRelation(
  strapi: any,
  targetDocumentId: string,
  sourceDocumentId: string,
  inverseType: string,
  reason?: string,
): Promise<void> {
  try {
    const target = await strapi.documents(ISSUE_UID).findOne({
      documentId: targetDocumentId,
      fields: ['documentId', 'relations'],
    });
    if (!target) return;

    const existing: any[] = Array.isArray(target.relations) ? target.relations : [];
    if (existing.some((r: any) => r.targetDocumentId === sourceDocumentId)) return;

    existing.push({
      type: inverseType,
      targetDocumentId: sourceDocumentId,
      reason: reason || 'Auto-synced inverse relation',
    });

    await strapi.documents(ISSUE_UID).update({
      documentId: targetDocumentId,
      data: { relations: existing },
    });

    strapi.log.info(
      `[relations] Synced inverse ${inverseType} on ${targetDocumentId} → ${sourceDocumentId}`
    );
  } catch (err: any) {
    strapi.log.warn(`[relations] Failed to sync inverse on ${targetDocumentId}: ${err.message}`);
  }
}

async function removeInverseRelation(
  strapi: any,
  targetDocumentId: string,
  sourceDocumentId: string,
): Promise<void> {
  try {
    const target = await strapi.documents(ISSUE_UID).findOne({
      documentId: targetDocumentId,
      fields: ['documentId', 'relations'],
    });
    if (!target) return;

    const existing: any[] = Array.isArray(target.relations) ? target.relations : [];
    const filtered = existing.filter((r: any) => r.targetDocumentId !== sourceDocumentId);
    if (filtered.length === existing.length) return; // nothing to remove

    await strapi.documents(ISSUE_UID).update({
      documentId: targetDocumentId,
      data: { relations: filtered },
    });

    strapi.log.info(
      `[relations] Removed inverse relation on ${targetDocumentId} → ${sourceDocumentId}`
    );
  } catch (err: any) {
    strapi.log.warn(`[relations] Failed to remove inverse on ${targetDocumentId}: ${err.message}`);
  }
}

/**
 * Scan an issue's description, acceptanceCriteria, and comments for ISS-\d+ references,
 * then auto-populate the `relations` JSON field with discovered links.
 * Called fire-and-forget when an issue transitions to resolved or failed.
 *
 * ISS-\d+ numbers correspond to the DB integer `id` field (not a separate issueNumber).
 */
export async function autoPopulateRelations(strapi: any, documentId: string): Promise<void> {
  const issue = await strapi.documents(ISSUE_UID).findOne({
    documentId,
    populate: ['project'],
    fields: ['documentId', 'title', 'description', 'acceptanceCriteria', 'relations'],
  });
  if (!issue?.project?.documentId) return;

  // Gather all text to scan
  const texts: string[] = [issue.description, issue.acceptanceCriteria].filter(Boolean);

  // Also scan comments
  const comments = await strapi.documents(COMMENT_UID).findMany({
    filters: { issue: { documentId: { $eq: documentId } } },
    fields: ['body'],
    limit: 100,
  });
  for (const c of comments) {
    if (c.body) texts.push(c.body);
  }

  const combined = texts.join('\n');

  // Extract all ISS-\d+ references (the number is the DB integer id)
  const referencedIds = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = ISS_PATTERN.exec(combined)) !== null) {
    referencedIds.add(parseInt(match[1], 10));
  }

  if (referencedIds.size === 0) return;

  // Resolve ISS ids to documentIds within the same project using db.query (supports id filter)
  const projectDocId = issue.project.documentId;
  const relatedIssues: any[] = await strapi.db.query('api::issue.issue').findMany({
    where: {
      id: { $in: Array.from(referencedIds) },
    },
  });

  if (relatedIssues.length === 0) return;

  // Build new relations, preserving existing ones
  const existing: any[] = Array.isArray(issue.relations) ? issue.relations : [];
  const existingTargets = new Set(existing.map((r: any) => r.targetDocumentId));

  const newRelations = [...existing];
  for (const related of relatedIssues) {
    const relDocId = related.documentId;
    // Skip self-references
    if (relDocId === documentId) continue;
    // Skip already linked
    if (existingTargets.has(relDocId)) continue;

    newRelations.push({
      type: 'related_to',
      targetDocumentId: relDocId,
      reason: `Referenced as ISS-${related.id} in issue text`,
    });
  }

  if (newRelations.length === existing.length) return; // nothing new

  await strapi.documents(ISSUE_UID).update({
    documentId,
    data: { relations: newRelations },
  });

  strapi.log.info(
    `[relations] Auto-populated ${newRelations.length - existing.length} relation(s) for ${documentId}`
  );
}

/**
 * When an issue advances past a blocking status, find other issues in the same
 * project that have a `blocked_by` or `depends_on` relation pointing to this issue.
 * If the dependent issue is still waiting (confirmed/approved) AND all of its
 * blockers have reached a done-enough status, re-trigger its pipeline step.
 */
export async function unblockDependents(strapi: any, blockerDocumentId: string): Promise<void> {
  const blocker = await strapi.documents(ISSUE_UID).findOne({
    documentId: blockerDocumentId,
    populate: ['project'],
    fields: ['documentId', 'id'],
  });
  if (!blocker?.project?.documentId) return;

  // Find all issues in the same project that might be blocked
  const projectIssues = await strapi.documents(ISSUE_UID).findMany({
    filters: {
      project: { documentId: { $eq: blocker.project.documentId } },
      status: { $in: ['confirmed', 'clarified', 'approved'] },
    },
    fields: ['documentId', 'id', 'status', 'relations'],
    limit: 200,
  });

  // Also find cross-project dependents: issues in OTHER projects that reference this blocker
  // via targetProjectDocId in their relations array. Use JSON containsi filter to narrow at DB level.
  const crossProjectIssues = await strapi.documents(ISSUE_UID).findMany({
    filters: {
      project: { documentId: { $ne: blocker.project.documentId } },
      status: { $in: ['confirmed', 'clarified', 'approved'] },
      relations: { $containsi: blockerDocumentId },
    },
    fields: ['documentId', 'id', 'status', 'relations'],
    limit: 50,
  });

  // Filter cross-project issues to only those with an actual blocking relation (not just any mention)
  const crossProjectDependents = crossProjectIssues.filter((issue: any) => {
    const relations: any[] = Array.isArray(issue.relations) ? issue.relations : [];
    return relations.some(
      (r: any) => (r.type === 'blocked_by' || r.type === 'depends_on') &&
        r.targetDocumentId === blockerDocumentId
    );
  });

  // Merge same-project and cross-project issues for unified processing
  projectIssues.push(...crossProjectDependents);

  for (const issue of projectIssues) {
    const relations: any[] = Array.isArray(issue.relations) ? issue.relations : [];
    const blockingRelations = relations.filter(
      (r: any) => r.type === 'blocked_by' || r.type === 'depends_on'
    );

    // Skip if this issue has no blocking relation to the current blocker
    const dependsOnThisBlocker = blockingRelations.some(
      (r: any) => r.targetDocumentId === blockerDocumentId
    );
    if (!dependsOnThisBlocker) continue;

    // Decomposition parent: use the narrower DECOMP_CHILD_READY_STATUSES set
    // (staging/released/closed) so the parent is only unblocked when every child
    // has actually staged. Prevents noisy re-triggers when children hit `developed`.
    const isDecompParent = blockingRelations.some(
      (r: any) => r.type === 'blocked_by' && r.reason?.includes('Decomposition child')
    );
    const readySet = isDecompParent ? DECOMP_CHILD_READY_STATUSES : DONE_ENOUGH_STATUSES;

    // Check ALL blockers — only proceed if every one has reached done-enough status
    const otherBlockerDocIds = blockingRelations
      .map((r: any) => r.targetDocumentId)
      .filter((docId: string) => docId !== blockerDocumentId);

    if (otherBlockerDocIds.length > 0) {
      const otherBlockers = await strapi.documents(ISSUE_UID).findMany({
        filters: { documentId: { $in: otherBlockerDocIds } },
        fields: ['documentId', 'id', 'status'],
        limit: otherBlockerDocIds.length,
      });

      // Treat missing/deleted blockers as still blocking (safe default)
      const returnedDocIds = new Set(otherBlockers.map((b: any) => b.documentId));
      const missingDocIds = otherBlockerDocIds.filter((docId: string) => !returnedDocIds.has(docId));
      if (missingDocIds.length > 0) {
        strapi.log.warn(
          `[relations] ISS-${issue.id}: ${missingDocIds.length} blocker(s) not found — treating as unresolved`
        );
      }

      const stillBlocked = otherBlockers.filter(
        (b: any) => !readySet.has(b.status)
      );

      if (stillBlocked.length > 0 || missingDocIds.length > 0) {
        const pendingIds = [
          ...stillBlocked.map((b: any) => `ISS-${b.id}`),
          ...missingDocIds.map((docId: string) => docId.slice(0, 8) + '(missing)'),
        ].join(', ');
        strapi.log.info(
          `[relations] ISS-${issue.id}: blocker ISS-${blocker.id} resolved, but still waiting on ${pendingIds}`
        );
        continue;
      }
    }

    strapi.log.info(
      `[relations] ISS-${issue.id}: all blockers resolved (last: ISS-${blocker.id}) — re-triggering pipeline`
    );

    // Post a comment notifying the unblock. Decomposition parents get a
    // more specific message since they're about to run integration testing,
    // not resume their own coding.
    const childCount = blockingRelations.filter(
      (r: any) => r.type === 'blocked_by' && r.reason?.includes('Decomposition child')
    ).length;
    const commentBody = isDecompParent
      ? `All ${childCount} decomposition child${childCount === 1 ? '' : 'ren'} reached staging (last: ISS-${blocker.id}) — advancing parent to integration test on staging.`
      : `All blockers resolved (last: ISS-${blocker.id}) — resuming pipeline.`;
    await strapi.documents(COMMENT_UID).create({
      data: {
        body: commentBody,
        author: 'Pipeline Bot',
        isAI: true,
        issue: issue.documentId,
      },
    });

    // Re-trigger the pipeline step for the dependent issue's current status
    triggerPipelineStep(strapi, issue.documentId, issue.status, issue.status).catch((err: any) =>
      strapi.log.warn(`[relations] re-trigger failed for ISS-${issue.id}: ${err.message}`)
    );
  }
}
