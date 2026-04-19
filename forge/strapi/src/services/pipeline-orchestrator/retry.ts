/**
 * Pipeline retry: create retry sessions bypassing lifecycle hooks.
 */

import { SESSION_UID, postPipelineComment } from '../pipeline-utils';
import type { PipelineConfig } from '../pipeline-antigravity';
import { resolveStepForStatus } from './config';
import { createQueuedSession, dispatchNextForProject } from './dispatch';

/**
 * Retry a failed pipeline step by creating a new queued session directly.
 *
 * Unlike onStatusChange, this bypasses:
 * - Lifecycle hooks (no activity records, webhooks, change history)
 * - shouldTrigger checks (already passed when the original session was created)
 * - Dedup time window (the failed session won't match since it's 'failed')
 * - Status reset (issue can stay at in_progress — we queue based on metadata)
 *
 * Still guarded by:
 * - createQueuedSession's dedup (won't double-queue if already queued for same toStatus)
 * - MAX_FRESH_RETRIES checked at promote time in promoteQueuedSession
 */
export async function retryPipelineStep(
  strapi: any,
  issueDocumentId: string,
  skill: string,
  triggerStatus: string,
  runner: 'desktop' | 'antigravity',
  model?: string,
  retryAfter?: string,
): Promise<string | null> {
  const issue = await strapi.documents('api::issue.issue').findOne({
    documentId: issueDocumentId,
    populate: ['project', 'project.defaultDevice'],
  });
  if (!issue?.project) {
    strapi.log.warn(`[pipeline] retryPipelineStep: issue ${issueDocumentId} not found`);
    return null;
  }

  const pipelineConfig: PipelineConfig = issue.project.agentConfig?.pipelineConfig || { enabled: false };
  const resolved = resolveStepForStatus(pipelineConfig, triggerStatus);
  if (!resolved) {
    strapi.log.warn(`[pipeline] retryPipelineStep: no skill mapped for status ${triggerStatus}`);
    return null;
  }

  // Skip retry if user has placed this issue on manual hold
  if ((issue as any).manualHold) {
    strapi.log.info(`[pipeline] ISS-${issue.id}: manualHold is set, skipping auto-retry`);
    return null;
  }

  // Decomposition parent: never auto-retry forge-code
  if (triggerStatus === 'approved' && resolved.skill === 'forge-code') {
    const relations: any[] = Array.isArray((issue as any).relations) ? (issue as any).relations : [];
    const isDecompParent = relations.some(
      (r: any) => r.type === 'blocked_by' && r.reason?.includes('Decomposition child')
    );
    if (isDecompParent) {
      strapi.log.info(
        `[pipeline] ISS-${issue.id}: skipping forge-code retry — decomposition parent, children do the coding`
      );
      return null;
    }
  }

  // Decomposition child release gate also applies to retries
  if (triggerStatus === 'released' && resolved.skill === 'forge-release') {
    const relations: any[] = Array.isArray((issue as any).relations) ? (issue as any).relations : [];
    const parentRel = relations.find(
      (r: any) => r.type === 'blocks' && r.reason?.includes('Decomposition child')
    );
    if (parentRel) {
      const parent = await strapi.documents('api::issue.issue').findOne({
        documentId: parentRel.targetDocumentId,
        fields: ['documentId', 'id', 'status'],
      });
      if (parent && parent.status !== 'released' && parent.status !== 'closed') {
        strapi.log.info(
          `[pipeline] ISS-${issue.id}: skipping forge-release retry — decomposition child, parent ISS-${parent.id} at ${parent.status}`
        );
        return null;
      }
    }
  }

  const sessionId = await createQueuedSession(strapi, issue, resolved, '', triggerStatus, { runner, model }, false);

  // Attach retryAfter for cooldown gate
  if (retryAfter && sessionId) {
    const sess = await strapi.documents(SESSION_UID).findOne({ documentId: sessionId });
    if (sess) {
      await strapi.documents(SESSION_UID).update({
        documentId: sessionId,
        data: { metadata: { ...sess.metadata, retryAfter } } as any,
      });
    }
  }

  strapi.log.info(
    `[pipeline] ISS-${issue.id}: retry queued ${skill} via ${runner} (auto-retry${retryAfter ? `, cooldown until ${retryAfter}` : ''})`,
  );

  setImmediate(() => {
    dispatchNextForProject(strapi, issue.project.documentId, runner).catch((err: any) =>
      strapi.log.warn(`[pipeline] retry dispatch failed: ${err.message}`),
    );
  });

  return sessionId;
}
