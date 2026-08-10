/**
 * ISS-238 — One-shot backfill that pauses any in-flight issue runs whose
 * current stage has its top-level `auto<Stage>` toggle on but no
 * `skill_registrations` row. Rebuilds the Anhome scenario where pipeline runs
 * looped the reconciler rescue path because there was no guard. Idempotent;
 * safe to run repeatedly (the helper's WHERE status='running' clamp dedupes).
 *
 * Wired into the boot block behind `FORGE_BACKFILL_MISSING_SKILL_PAUSES=1` so
 * operators can re-trigger it on demand. The auto-resume subscriber
 * (`missing-skill-resume.ts`) takes over once the operator fixes the gap.
 */

import { and, eq, inArray, isNull, not, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  issues,
  pipelineRuns,
  projects,
  skillRegistrations,
} from '../db/schema.js';
import { logger } from '../logger.js';
import { pausePipelineRunMissingSkill, postMissingSkillComment } from './missing-skill-guard.js';
import { PIPELINE_STEPS } from './registry.js';

export interface BackfillResult {
  scanned: number;
  paused: number;
  alreadyPaused: number;
  errored: number;
}

function isToggleEnabledFor(pipeline: Record<string, unknown>, toggle: string): boolean {
  const v = pipeline[toggle];
  if (v === true) return true;
  if (typeof v === 'object' && v !== null) {
    return (v as { enabled?: boolean }).enabled !== false;
  }
  return false;
}

interface CandidateRow {
  issueId: string;
  projectId: string;
  status: IssueStatus;
  runId: string;
  currentStep: string | null;
}

export async function backfillMissingSkillPauses(
  projectId?: string,
): Promise<BackfillResult> {
  const autoStatuses = PIPELINE_STEPS.map((s) => s.status);

  // 1. Find issues currently parked at an auto-dispatch stage with NO skill
  //    registration for that stage, joined to their open issue-run. Filter
  //    project-scoped only when caller passes a `projectId`.
  const baseFilters = [
    eq(pipelineRuns.kind, 'issue'),
    eq(pipelineRuns.status, 'running'),
    inArray(issues.status, autoStatuses),
    not(
      sql`EXISTS (
        SELECT 1 FROM ${skillRegistrations}
        WHERE ${skillRegistrations.projectId} = ${issues.projectId}
          AND ${skillRegistrations.stage} = ${issues.status}
      )`,
    ),
    not(isNull(pipelineRuns.issueId)),
  ];
  if (projectId) baseFilters.push(eq(issues.projectId, projectId));

  const candidates: CandidateRow[] = await db
    .select({
      issueId: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      runId: pipelineRuns.id,
      currentStep: pipelineRuns.currentStep,
    })
    .from(issues)
    .innerJoin(pipelineRuns, eq(pipelineRuns.issueId, issues.id))
    .where(and(...baseFilters));

  if (candidates.length === 0) {
    return { scanned: 0, paused: 0, alreadyPaused: 0, errored: 0 };
  }

  // 2. Resolve each candidate's project pipelineConfig once (deduped) so we
  //    only pause when the top-level toggle for that stage is actually on.
  //    Projects with `autoReview=false` and no skill are legitimate manual
  //    workflows — leave their runs alone.
  const uniqueProjectIds = Array.from(new Set(candidates.map((c) => c.projectId)));
  const projectRows = await db
    .select({ id: projects.id, agentConfig: projects.agentConfig })
    .from(projects)
    .where(inArray(projects.id, uniqueProjectIds));

  const pipelineByProject = new Map<string, Record<string, unknown>>();
  for (const row of projectRows) {
    const ac = (row.agentConfig ?? {}) as { pipelineConfig?: Record<string, unknown> };
    pipelineByProject.set(row.id, ac.pipelineConfig ?? {});
  }

  const toggleByStatus = new Map<string, string>(PIPELINE_STEPS.map((s) => [s.status, s.toggle]));

  const result: BackfillResult = {
    scanned: candidates.length,
    paused: 0,
    alreadyPaused: 0,
    errored: 0,
  };

  for (const row of candidates) {
    const pipeline = pipelineByProject.get(row.projectId);
    if (!pipeline) continue;
    if (pipeline.enabled !== true) continue;
    const toggle = toggleByStatus.get(row.status);
    if (!toggle) continue;
    if (!isToggleEnabledFor(pipeline, toggle)) continue;

    try {
      const { paused, alreadyPaused } = await pausePipelineRunMissingSkill({
        runId: row.runId,
        projectId: row.projectId,
        issueId: row.issueId,
        stage: row.status,
        currentStep: row.currentStep,
      });
      if (paused) {
        result.paused++;
        await postMissingSkillComment({
          projectId: row.projectId,
          issueId: row.issueId,
          stage: row.status,
        });
      } else if (alreadyPaused) {
        result.alreadyPaused++;
      }
    } catch (err) {
      result.errored++;
      logger.warn(
        { err, runId: row.runId, issueId: row.issueId, stage: row.status },
        'missing-skill-backfill: failed to pause run',
      );
    }
  }

  logger.info(result, 'missing-skill-backfill: scan complete');
  return result;
}
