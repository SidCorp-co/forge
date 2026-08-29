// What a human answer means to the autonomous driver.
//
// The staged pipeline parks an issue at `needs_info` and waits for a person to
// press a button: the question is asked by one step and answered before the
// next one is dispatched, so a human is in the loop anyway. The autonomous
// driver has no next step to dispatch — the session that asked the question is
// gone, and the only thing that can bring one back is the answer itself.
//
// So under `mode: 'autonomous'` a human comment on a `needs_info` issue IS the
// resume, and it moves the issue back to the entry status the same way any
// other actor would. Nothing here dispatches; the orchestrator's transition
// hook does, exactly as it does for a button press.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { transitionIssueStatus } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { AUTONOMOUS_ENTRY_STATUS, isAutonomous } from './autonomous-dispatch.js';
import type { HooksBus } from './hooks.js';
import { pipelineConfigSchema } from './pipeline-config-schema.js';

/** The park the driver enters to ask a question. */
// cm:edge lockstep -> packages/core/src/jobs/turn-verdict-routes.ts — the turn verdict asks the SAME question from the other end (may this session stay resident?), and the two answers must name one status: a verdict that parked on `waiting` too would hold a runner slot for a pause a human chose, and a resume that did would take that pause away from them.
export const QUESTION_STATUS = 'needs_info';

// cm:guard `needs_info` ONLY, never the other two parks the autonomous vocabulary also renders as needs_human — `waiting` and `on_hold` are stopped by a person, and a comment on one is discussion, not permission to restart. Resuming those would take the pause away from the human who chose it.
async function resumableIssue(issueId: string) {
  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue || issue.status !== QUESTION_STATUS) return null;
  const [project] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, issue.projectId))
    .limit(1);
  const ac = (project?.agentConfig as { pipelineConfig?: unknown } | null) ?? {};
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  if (!parsed.success || !isAutonomous(parsed.data)) return null;
  return issue;
}

/**
 * Register the answer-resume subscriber. Called once at boot from
 * `src/index.ts`, and only meaningful for projects running the autonomous
 * driver — a staged project takes the early return and pays one issue read.
 */
export function registerAnswerResume(bus: HooksBus): void {
  bus.on(
    'commentCreated',
    async (p) => {
      // cm:guard every AI comment path emits a `device` actor (mcp/tools/forge-comments.ts, forge-issues.ts) — widening this to any actor would let the driver's own question resume the issue it just parked, in a loop nothing else stops
      if (p.actor.type !== 'user') return;
      try {
        const issue = await resumableIssue(p.issueId);
        if (!issue) return;
        await transitionIssueStatus(issue, AUTONOMOUS_ENTRY_STATUS, {
          type: 'user',
          id: p.actor.id,
        });
        logger.info(
          { issueId: p.issueId, commentId: p.commentId },
          'answer-resume: human answered, issue returned to the driver',
        );
      } catch (err) {
        logger.error({ err, issueId: p.issueId }, 'answer-resume: transition failed');
        throw err;
      }
    },
    { name: 'answer-resume' },
  );
}
