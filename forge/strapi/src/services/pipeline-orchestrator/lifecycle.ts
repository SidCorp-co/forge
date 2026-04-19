/**
 * Pipeline lifecycle: session completion and status change handling.
 */

import {
  SESSION_UID,
  MAX_REOPEN_CYCLES,
  countReopenCycles,
  postPipelineComment,
  checkDependenciesResolved,
  hasRunningSessionForIssue,
  DECOMP_CHILD_READY_STATUSES,
} from '../pipeline-utils';
import type { PipelineConfig } from '../pipeline-antigravity';
import {
  STEP_TOGGLES,
  shouldTrigger,
  resolveStepForStatus,
  shouldSkipStep,
  resolveStepConfig,
  DEDUP_WINDOW_MS,
} from './config';
import {
  withLock,
  statusChangeLocks,
  dispatchNextForProject,
  createQueuedSession,
} from './dispatch';

/**
 * Called from agent:complete relay when a session finishes.
 * Dispatches the next queued session for the same project+runner.
 */
export async function onSessionComplete(strapi: any, sessionDocumentId: string) {
  const session = await strapi.documents(SESSION_UID).findOne({
    documentId: sessionDocumentId,
    populate: ['project', 'issues'],
  });
  const projectDocId = session?.project?.documentId;
  if (!projectDocId) return;

  // forge-review auto-advance: when a forge-review session completes successfully
  // and the linked issue is still at `developed`, advance to `deploying` (APPROVE).
  if (
    session.status === 'completed' &&
    session.metadata?.type === 'pipeline' &&
    session.metadata?.skill === 'forge-review' &&
    session.issues?.length
  ) {
    for (const issue of session.issues) {
      try {
        const current = await strapi.documents('api::issue.issue').findOne({
          documentId: issue.documentId,
          fields: ['documentId', 'id', 'status'],
        });
        if (current?.status === 'developed') {
          strapi.log.info(
            `[pipeline] ISS-${current.id}: forge-review completed without status change — auto-advancing developed → deploying (APPROVE)`
          );
          await strapi.documents('api::issue.issue').update({
            documentId: current.documentId,
            data: { status: 'deploying' } as any,
          });
        }
      } catch (err: any) {
        strapi.log.warn(
          `[pipeline] forge-review auto-advance failed for ${issue.documentId}: ${err.message}`
        );
      }
    }
  }

  const runner = session.metadata?.runner || 'desktop';
  await dispatchNextForProject(strapi, projectDocId, runner);

  const otherRunner = runner === 'desktop' ? 'antigravity' : 'desktop';
  await dispatchNextForProject(strapi, projectDocId, otherRunner);
}

/**
 * Called from issue lifecycle afterUpdate when status changes.
 * Decision layer: decides whether to run a step, creates a queued session,
 * then calls the unified dispatcher.
 */
export async function onStatusChange(
  strapi: any,
  issueDocumentId: string,
  fromStatus: string,
  toStatus: string,
  manual = false,
  options?: { heartbeat?: boolean },
): Promise<string | null> {
  return withLock(statusChangeLocks, issueDocumentId, async () => {
  const issue = await strapi.documents('api::issue.issue').findOne({
    documentId: issueDocumentId,
    populate: ['project', 'project.defaultDevice'],
  });

  if (!issue?.project) {
    strapi.log.warn(`[pipeline] ${issueDocumentId}: no project found, skipping`);
    return null;
  }

  const agentConfig = issue.project.agentConfig || {};
  const pipelineConfig: PipelineConfig = agentConfig.pipelineConfig || { enabled: false };

  const resolved = resolveStepForStatus(pipelineConfig, toStatus);

  if (!shouldTrigger(toStatus, fromStatus, pipelineConfig, manual)) {
    if (resolved?.nextStatus) {
      const skipMatched = resolved.skip && shouldSkipStep(issue, resolved.skip);
      const toggleKey = STEP_TOGGLES[toStatus];
      const toggleDisabled = toggleKey && !resolveStepConfig(pipelineConfig[toggleKey] as any).enabled;
      if (skipMatched || toggleDisabled) {
        const reason = skipMatched
          ? `${resolved.skip!.field} ${resolved.skip!.op} ${JSON.stringify(resolved.skip!.value)}`
          : `toggle ${toggleKey} disabled`;
        strapi.log.info(
          `[pipeline] ISS-${issue.id} ${toStatus}: skipping ${resolved.skill}, auto-advancing to ${resolved.nextStatus} (${reason})`,
        );
        await strapi.documents('api::issue.issue').update({
          documentId: issueDocumentId,
          data: { status: resolved.nextStatus } as any,
        });
        return null;
      }
    }
    strapi.log.debug(
      `[pipeline] ISS-${issue.id} ${fromStatus} → ${toStatus}: skipped (enabled=${pipelineConfig.enabled}, manual=${manual}, step=${JSON.stringify(pipelineConfig[STEP_TOGGLES[toStatus] as keyof PipelineConfig])})`,
    );
    return null;
  }

  // Manual hold
  if (!manual && (issue as any).manualHold) {
    strapi.log.info(`[pipeline] ISS-${issue.id}: manualHold is set, skipping automatic trigger`);
    return null;
  }

  // Loop protection
  if (!manual && toStatus === 'reopen') {
    const reopenCount = await countReopenCycles(strapi, issueDocumentId);
    if (reopenCount >= MAX_REOPEN_CYCLES) {
      strapi.log.warn(
        `[pipeline] ISS-${issue.id}: reopen cycle limit reached (${reopenCount}/${MAX_REOPEN_CYCLES}), skipping auto-fix`,
      );
      await postPipelineComment(strapi, issueDocumentId,
        `Auto-fix stopped — issue has been reopened ${reopenCount} times. Setting \`manualHold\` for manual review.`,
        'Pikachu',
      );
      await strapi.documents('api::issue.issue' as any).update({ documentId: issueDocumentId, data: { manualHold: true } });
      return null;
    }
  }

  // Dependency gate
  if (toStatus === 'clarified' || toStatus === 'approved') {
    const depCheck = await checkDependenciesResolved(strapi, issueDocumentId);
    if (depCheck.blocked) {
      strapi.log.info(
        `[pipeline] ISS-${issue.id} ${fromStatus}→${toStatus}: blocked by unresolved dependencies (${depCheck.pendingIds.join(', ')}), skipping pipeline step`,
      );
      const relations: any[] = Array.isArray((issue as any).relations) ? (issue as any).relations : [];
      const isDecompParent = relations.some(
        (r: any) => r.type === 'blocked_by' && r.reason?.includes('Decomposition child')
      );
      if (!isDecompParent) {
        await postPipelineComment(
          strapi,
          issueDocumentId,
          `Pipeline paused at \`${toStatus}\` — waiting on dependencies: ${depCheck.pendingIds.join(', ')}. Will resume automatically when all blockers are resolved.`,
          'Pipeline Bot',
        );
      }
      return null;
    }
  }

  if (!resolved) {
    strapi.log.debug(`[pipeline] ISS-${issue.id} ${toStatus}: no step resolved, skipping`);
    return null;
  }

  // Decomposition parent handling at `approved`
  if (toStatus === 'approved') {
    const relations: any[] = Array.isArray((issue as any).relations) ? (issue as any).relations : [];
    const decompChildren = relations.filter(
      (r: any) => r.type === 'blocked_by' && r.reason?.includes('Decomposition child')
    );
    if (decompChildren.length > 0) {
      let allReady = true;
      for (const rel of decompChildren) {
        const child = await strapi.documents('api::issue.issue').findOne({
          documentId: rel.targetDocumentId,
          fields: ['documentId', 'id', 'status'],
        });
        if (!child || !DECOMP_CHILD_READY_STATUSES.has(child.status)) {
          allReady = false;
          break;
        }
      }
      if (allReady) {
        strapi.log.info(
          `[pipeline] ISS-${issue.id}: all ${decompChildren.length} decomposition children staged, advancing parent to deploying`
        );
        await strapi.documents('api::issue.issue').update({
          documentId: issueDocumentId,
          data: { status: 'deploying' } as any,
        });
        return null;
      }
      strapi.log.info(
        `[pipeline] ISS-${issue.id}: decomposition parent parked at approved, waiting for ${decompChildren.length} children to stage`
      );
      return null;
    }
  }

  // Decomposition child release gate
  if (toStatus === 'released') {
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
          `[pipeline] ISS-${issue.id}: release gated — parent ISS-${parent.id} at ${parent.status}, parking child`
        );
        await postPipelineComment(
          strapi,
          issueDocumentId,
          `Release gated — waiting for parent ISS-${parent.id} integration test. Parent coordinates the merge to production.`,
          'Pipeline Bot',
        );
        return null;
      }
    }
  }

  // Evaluate skip condition
  if (resolved.skip && shouldSkipStep(issue, resolved.skip)) {
    strapi.log.info(
      `[pipeline] ISS-${issue.id} ${toStatus}: skipping ${resolved.skill} (${resolved.skip.field} ${resolved.skip.op} ${JSON.stringify(resolved.skip.value)})`,
    );
    if (resolved.nextStatus) {
      await strapi.documents('api::issue.issue').update({
        documentId: issueDocumentId,
        data: { status: resolved.nextStatus } as any,
      });
    }
    return null;
  }

  const toggleKey = STEP_TOGGLES[toStatus];
  const toggleStepConfig = resolveStepConfig(
    toggleKey ? (pipelineConfig[toggleKey] as any) : true,
  );
  const stepConfig = {
    enabled: toggleStepConfig.enabled,
    runner: resolved.runner || toggleStepConfig.runner,
    model: resolved.model || toggleStepConfig.model,
  };

  // Dedup
  if (!manual && !options?.heartbeat) {
    const recentSessions = await strapi.documents(SESSION_UID).findMany({
      filters: {
        issues: { documentId: { $eq: issueDocumentId } },
        createdAt: { $gte: new Date(Date.now() - DEDUP_WINDOW_MS).toISOString() },
      },
      limit: 5,
    });
    const recentDup = recentSessions.find(
      (s: any) => s.metadata?.type === 'pipeline' && s.metadata?.toStatus === toStatus
        && (s.status === 'queued' || s.status === 'running' || s.status === 'completed'),
    );
    if (recentDup) {
      strapi.log.info(
        `[pipeline] ISS-${issue.id} ${fromStatus}→${toStatus}: skipped (duplicate within ${DEDUP_WINDOW_MS / 1000}s, session ${recentDup.documentId} is ${recentDup.status})`,
      );
      return null;
    }
  }

  const sessionId = await createQueuedSession(strapi, issue, resolved, fromStatus, toStatus, stepConfig, manual, options?.heartbeat ? { origin: 'heartbeat' } : undefined);

  if (await hasRunningSessionForIssue(strapi, issueDocumentId)) {
    strapi.log.info(
      `[pipeline] ISS-${issue.id} ${fromStatus} → ${toStatus}: queued while previous session still running (will dispatch on completion)`,
    );
  }

  strapi.log.info(
    `[pipeline] ISS-${issue.id} ${fromStatus} → ${toStatus}: queued ${resolved.skill} via ${stepConfig.runner}${manual ? ' (manual)' : ''}`,
  );

  setImmediate(() => {
    dispatchNextForProject(strapi, issue.project.documentId, stepConfig.runner).catch((err: any) =>
      strapi.log.warn(`[pipeline] dispatch failed: ${err.message}`),
    );
  });

  return sessionId;
  }); // end withLock(statusChangeLocks)
}
