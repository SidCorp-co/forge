// The release gate: an autonomous agent may finish an issue, but it may not
// declare it shipped.
//
// The driver ends by merging into the base branch and setting `closed`, and
// `closed` is what every surface reads as done. Nothing had run between "the
// code is on `dev`" and "it is live, and someone checked": epodsystem ISS-141
// self-closed at 08:47Z on 2026-08-24 with the reported bug still reproducing,
// and a human reopened it five minutes later.
//
// So on a project that declares a gate, an agent's close is rewritten to the
// gate status instead of rejected. Rejecting would strand the session with
// nowhere legal to go; the rewrite lets it finish honestly and moves the claim
// to the only writer entitled to make it — `release_batch finish`, which runs
// after a release actually happened.
//
// `dropped` is untouched on purpose: it means "this was not work", and holding
// a non-issue for a release it will never be part of parks it forever.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import { isAutonomous } from '../pipeline/autonomous-mode.js';
import type { PipelineConfig } from '../pipeline/pipeline-config-schema.js';
import { pipelineConfigSchema } from '../pipeline/pipeline-config-schema.js';
import { resolveReleaseGateStatus } from '../release-batch/gate.js';

export interface CloseTargetDecision {
  status: IssueStatus;
  /** The close was converted into a park at the gate. */
  held: boolean;
}

/**
 * Where an agent's `closed` actually lands. Every other target, every human
 * actor, every staged project and the release path itself pass through.
 */
// cm:guard the `actorType === 'device'` check is what keeps a human's close working: an operator closing an issue by hand is making the shipped claim deliberately and owns it, while an agent has no way to know whether anything was released
export async function resolveAgentCloseTarget(args: {
  projectId: string;
  requested: IssueStatus;
  actorType: 'user' | 'device';
  viaReleasePath: boolean;
}): Promise<CloseTargetDecision> {
  const pass = { status: args.requested, held: false };
  if (args.requested !== 'closed') return pass;
  if (args.actorType !== 'device') return pass;
  if (args.viaReleasePath) return pass;

  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, args.projectId))
    .limit(1);
  const ac = (row?.agentConfig ?? {}) as { pipelineConfig?: unknown };
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  const cfg: PipelineConfig | null = parsed.success ? parsed.data : null;

  // cm:guard staged projects are excluded deliberately — their release job closes the issue with a device actor and no bypass, so holding it there would rewrite the release's own close back to the gate and loop forever
  if (!isAutonomous(cfg)) return pass;

  const gate = resolveReleaseGateStatus(cfg);
  if (!gate) return pass;
  return { status: gate, held: true };
}
