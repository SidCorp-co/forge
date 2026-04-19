import type { Core } from '@strapi/strapi';
import { broadcast } from './websocket';

// Pipeline statuses where auto-close would skip required gates (deploy/test/staging)
const PIPELINE_ACTIVE_STATUSES = ['in_progress', 'deploying', 'testing', 'staging'];

export async function checkIssueResolution(strapi: Core.Strapi, task: any) {
  // Get task with issue populated
  const fullTask = await strapi.documents('api::task.task').findOne({
    documentId: task.documentId,
    populate: ['issue'],
  });

  if (!fullTask?.issue) return;

  const issueDocumentId = fullTask.issue.documentId;

  // Get all tasks for this issue using nested relation filter
  const allTasks = await strapi.documents('api::task.task').findMany({
    filters: { issue: { documentId: { $eq: issueDocumentId } } },
  });

  if (allTasks.length === 0) return;

  const allDone = allTasks.every((t: any) => t.status === 'done');

  if (allDone) {
    // Don't auto-close issues in pipeline-active statuses — they need to go
    // through deploying → testing → staging → released → closed gates
    const issue = await strapi.documents('api::issue.issue').findOne({
      documentId: issueDocumentId,
      fields: ['status'],
    });
    if (issue && PIPELINE_ACTIVE_STATUSES.includes(issue.status)) return;

    await strapi.documents('api::issue.issue').update({
      documentId: issueDocumentId,
      data: { status: 'closed' },
    });

    broadcast('issue:closed', { documentId: issueDocumentId });
  }
}
