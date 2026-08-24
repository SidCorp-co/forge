// ISS-141 — `reopen` is a status the autonomous driver cannot answer for.
//
// The staged pipeline reads `reopen` as "a step rejected this; route it back to
// whichever step owns the fix". The autonomous driver has no steps:
// `autonomousStepFor` answers for `open` and for nothing else, so an issue that
// lands on `reopen` is queued for a driver that will never look at it. It
// rendered as a live session on the board, and the reconciler re-read it every
// 60s, found nothing to do, and counted a rescue each time. Measured on
// forge-beta 2026-08-24: epodsystem ISS-141 sat there for over an hour.
//
// So the status is rewritten at write time rather than detected afterwards —
// the same shape as `issues/intake-gate.ts` and for the same reason: a park no
// dispatcher will ever pick up must not be representable. What `reopen` MEANS
// survives, because the rewrite lands after the guards have run against the
// requested status: the reopen counter still increments and the authored reason
// is still required and still posted under its `🔁 Reopened from X` heading.
//
// Design: docs/proposals/release-gate-and-deploy.md (L0.4)

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import { AUTONOMOUS_ENTRY_STATUS, isAutonomous } from '../pipeline/autonomous-mode.js';
import type { PipelineConfig } from '../pipeline/pipeline-config-schema.js';

/**
 * Rewrite a requested `reopen` into the status the autonomous driver
 * dispatches. Every other target, and every staged project, passes through
 * untouched — one project's driver must never change another's vocabulary.
 */
// cm:guard call this AFTER the transition guards, never before: `requiresAuthoredReason` and `isReopenEntry` both key on the REQUESTED status, and resolving first silently drops the reason requirement and the reopen counter — which is the entire quality signal a reopen carries
export async function resolveAutonomousReopenTarget(
  projectId: string,
  requested: IssueStatus,
): Promise<IssueStatus> {
  if (requested !== 'reopen') return requested;
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const ac = (row?.agentConfig ?? {}) as { pipelineConfig?: unknown };
  return isAutonomous((ac.pipelineConfig ?? null) as PipelineConfig | null)
    ? AUTONOMOUS_ENTRY_STATUS
    : requested;
}
