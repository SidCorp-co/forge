/**
 * Session Context Embedder — embeds issue sessionContext fields in Qdrant
 * for cross-issue knowledge search (decisions, filesModified, errorsResolved, reviewFeedback).
 *
 * Triggered on status change to 'developed' or 'closed'.
 * Each field becomes a separate Qdrant point with source_type='session_context'.
 */

import pLimit from 'p-limit';
import { upsertEmbedding } from './embeddings';
import { upsertEdge } from './knowledge-graph';

const ISSUE_UID = 'api::issue.issue' as any;

/** Fields to embed and their source_id suffix + edge predicate */
const FIELD_CONFIG: Record<string, { suffix: string; predicate: string }> = {
  decisions: { suffix: 'decisions', predicate: 'decided' },
  filesModified: { suffix: 'files', predicate: 'modified' },
  errorsResolved: { suffix: 'errors', predicate: 'resolved' },
  reviewFeedback: { suffix: 'review', predicate: 'has_feedback' },
};

/**
 * Format a sessionContext field's array content into readable text for embedding.
 */
function formatFieldText(fieldName: string, items: string[], issueTitle: string): string {
  if (fieldName === 'decisions') {
    return `Decisions from "${issueTitle}":\n${items.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;
  }
  if (fieldName === 'filesModified') {
    return `Files modified in "${issueTitle}":\n${items.join('\n')}`;
  }
  if (fieldName === 'errorsResolved') {
    return `Errors resolved in "${issueTitle}":\n${items.map((e, i) => `${i + 1}. ${e}`).join('\n')}`;
  }
  if (fieldName === 'reviewFeedback') {
    return `Review feedback from "${issueTitle}":\n${items.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
  }
  return items.join('\n');
}

/**
 * Embed a single sessionContext field into Qdrant.
 */
async function embedField(
  projectId: string,
  issueDocId: string,
  issueId: number,
  issueTitle: string,
  category: string | undefined,
  fieldName: string,
  items: string[],
): Promise<void> {
  const config = FIELD_CONFIG[fieldName];
  if (!config) return;

  const text = formatFieldText(fieldName, items, issueTitle);
  const sourceId = `${issueDocId}:${config.suffix}`;

  await upsertEmbedding({
    project_id: projectId,
    source_type: 'session_context',
    source_id: sourceId,
    text,
    metadata: {
      issueDocumentId: issueDocId,
      issueId,
      fieldName,
      issueTitle,
      category,
    },
  });
}

/**
 * Extract file paths from text using common path patterns.
 */
function extractFilePaths(text: string): string[] {
  const pathRegex = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(text)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/**
 * Create knowledge graph edges from sessionContext fields.
 */
async function extractEdges(
  strapi: any,
  projectId: string,
  issueDocId: string,
  sessionContext: any,
): Promise<number> {
  let count = 0;
  const sourceMemoryId = `session_context:${issueDocId}`;

  const decisions: string[] = sessionContext.decisions || [];
  for (const decision of decisions) {
    const summary = decision.slice(0, 60).toLowerCase().trim();
    if (!summary) continue;
    await upsertEdge(strapi, projectId, {
      subject: issueDocId,
      predicate: 'decided',
      object: summary,
      sourceMemoryId,
    });
    count++;
  }

  const files: string[] = sessionContext.filesModified || [];
  for (const filePath of files) {
    const normalized = filePath.toLowerCase().trim();
    if (!normalized) continue;
    await upsertEdge(strapi, projectId, {
      subject: issueDocId,
      predicate: 'modified',
      object: normalized,
      sourceMemoryId,
    });
    count++;
  }

  const errors: string[] = sessionContext.errorsResolved || [];
  for (const error of errors) {
    const summary = error.slice(0, 60).toLowerCase().trim();
    if (!summary) continue;
    await upsertEdge(strapi, projectId, {
      subject: issueDocId,
      predicate: 'resolved',
      object: summary,
      sourceMemoryId,
    });
    count++;

    // Cross-link error → file if error text contains file paths
    const filePaths = extractFilePaths(error);
    for (const fp of filePaths) {
      await upsertEdge(strapi, projectId, {
        subject: summary,
        predicate: 'occurred_in',
        object: fp.toLowerCase(),
        sourceMemoryId,
      });
      count++;
    }
  }

  const feedback: string[] = sessionContext.reviewFeedback || [];
  for (const fb of feedback) {
    const summary = fb.slice(0, 60).toLowerCase().trim();
    if (!summary) continue;
    await upsertEdge(strapi, projectId, {
      subject: issueDocId,
      predicate: 'has_feedback',
      object: summary,
      sourceMemoryId,
    });
    count++;
  }

  return count;
}

/**
 * Embed all sessionContext fields for a single issue.
 * Skips fields that are empty or missing.
 */
export async function embedSessionContext(
  strapi: any,
  projectId: string,
  issueDocumentId: string,
): Promise<{ fieldsEmbedded: number; edgesCreated: number }> {
  const issue = await strapi.documents(ISSUE_UID).findOne({
    documentId: issueDocumentId,
    populate: ['project'],
  });

  if (!issue?.sessionContext || !issue.project?.documentId) {
    return { fieldsEmbedded: 0, edgesCreated: 0 };
  }

  const ctx = issue.sessionContext;
  let fieldsEmbedded = 0;

  for (const fieldName of Object.keys(FIELD_CONFIG)) {
    const items: unknown = ctx[fieldName];
    if (!Array.isArray(items) || items.length === 0) continue;

    // Ensure all items are strings
    const stringItems = items.filter((i): i is string => typeof i === 'string' && i.trim().length > 0);
    if (stringItems.length === 0) continue;

    try {
      await embedField(
        projectId,
        issueDocumentId,
        issue.id,
        issue.title,
        issue.category,
        fieldName,
        stringItems,
      );
      fieldsEmbedded++;
    } catch (err: any) {
      strapi.log.warn(`[session-context] embed ${fieldName} failed for ${issueDocumentId}: ${err.message}`);
    }
  }

  let edgesCreated = 0;
  try {
    edgesCreated = await extractEdges(strapi, projectId, issueDocumentId, ctx);
  } catch (err: any) {
    strapi.log.warn(`[session-context] edge extraction failed for ${issueDocumentId}: ${err.message}`);
  }

  if (fieldsEmbedded > 0 || edgesCreated > 0) {
    strapi.log.info(`[session-context] ISS-${issue.id}: embedded ${fieldsEmbedded} fields, ${edgesCreated} edges`);
  }

  return { fieldsEmbedded, edgesCreated };
}

/**
 * Backfill session context embeddings for all issues with sessionContext.
 * Optionally filtered by projectId.
 */
export async function backfillSessionContextEmbeddings(
  strapi: any,
  projectId?: string,
): Promise<{ processed: number; skipped: number; errors: number }> {
  const limit = pLimit(3);
  const filters: any = {
    sessionContext: { $notNull: true },
  };
  if (projectId) {
    filters.project = { documentId: { $eq: projectId } };
  }

  const issues = await strapi.documents(ISSUE_UID).findMany({
    filters,
    fields: ['documentId', 'sessionContext'],
    populate: ['project'],
    limit: 500,
  });

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  const tasks = issues.map((issue: any) =>
    limit(async () => {
      if (!issue.sessionContext || !issue.project?.documentId) {
        skipped++;
        return;
      }

      // Check if there's any embeddable content
      const hasContent = Object.keys(FIELD_CONFIG).some((field) => {
        const items = issue.sessionContext[field];
        return Array.isArray(items) && items.length > 0;
      });

      if (!hasContent) {
        skipped++;
        return;
      }

      try {
        await embedSessionContext(strapi, issue.project.documentId, issue.documentId);
        processed++;
      } catch (err: any) {
        strapi.log.warn(`[session-context] backfill failed for ${issue.documentId}: ${err.message}`);
        errors++;
      }
    }),
  );

  await Promise.all(tasks);

  strapi.log.info(`[session-context] backfill complete: processed=${processed}, skipped=${skipped}, errors=${errors}`);
  return { processed, skipped, errors };
}
