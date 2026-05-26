/**
 * ISS-238 — Auto-resume subscriber. When `skillRegistered` fires for a
 * non-null stage, find every paused `pipeline_run` whose
 * `metadata.pauseReason === "missing_skill:<stage>"` for the same project,
 * flip them back to `running`, and re-enter the orchestrator so the now-
 * dispatchable job actually gets enqueued. Closes the operator-facing loop:
 * fix the missing registration → pipeline resumes itself.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns } from '../db/schema.js';
import { logger } from '../logger.js';
import type { HooksBus } from './hooks.js';
import { PAUSE_REASON_PREFIX, buildMissingSkillReason } from './missing-skill-guard.js';
import { reEnqueueForIssue } from './orchestrator.js';

export function registerMissingSkillResume(bus: HooksBus): void {
  bus.on('skillRegistered', async (payload) => {
    if (!payload.stage) return; // null = unbind — handled by service-side guard

    const matchingReason = buildMissingSkillReason(payload.stage as IssueStatus);

    const resumed = await db
      .update(pipelineRuns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(
        and(
          eq(pipelineRuns.projectId, payload.projectId),
          eq(pipelineRuns.status, 'paused'),
          sql`${pipelineRuns.metadata} ->> 'pauseReason' = ${matchingReason}`,
        ),
      )
      .returning({
        id: pipelineRuns.id,
        issueId: pipelineRuns.issueId,
        currentStep: pipelineRuns.currentStep,
      });

    if (resumed.length === 0) return;

    logger.info(
      { projectId: payload.projectId, stage: payload.stage, resumed: resumed.length },
      'missing-skill-resume: resumed paused runs after skill registration',
    );

    for (const run of resumed) {
      await bus.emit('pipelineRunStatusChanged', {
        runId: run.id,
        projectId: payload.projectId,
        issueId: run.issueId,
        kind: 'issue',
        fromStatus: 'paused',
        toStatus: 'running',
        currentStep: run.currentStep,
      });

      if (!run.issueId) continue;
      try {
        const [iss] = await db
          .select({ status: issues.status })
          .from(issues)
          .where(eq(issues.id, run.issueId))
          .limit(1);
        if (!iss) continue;
        await reEnqueueForIssue({
          projectId: payload.projectId,
          issueId: run.issueId,
          status: iss.status,
          actor: { type: 'user', id: payload.actorUserId },
          reason: { autoResume: PAUSE_REASON_PREFIX.replace(':', ''), stage: payload.stage },
        });
      } catch (err) {
        logger.warn(
          { err, runId: run.id, issueId: run.issueId },
          'missing-skill-resume: re-enqueue failed after resume',
        );
      }
    }
  });
}
