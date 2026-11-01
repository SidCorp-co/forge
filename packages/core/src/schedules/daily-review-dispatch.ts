// The `daily_review` schedule branch (ISS-862): each fire hands the project's master its daily review
// brief (`masters/daily-review.ts`). It starts no session of its own: the master is the actor. A fire
// no master took is settled skipped with the refusal naming why, never in silence.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { deliverDailyReview } from '../masters/index.js';
import type { DispatchScheduleInput, RoutedFire } from './dispatch-types.js';

export async function routeScheduleDailyReviewFire(
  input: DispatchScheduleInput,
  fireId: string,
): Promise<RoutedFire> {
  const { projectId } = input.schedule;
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    return {
      result: { ok: false, reason: 'project-not-found', status: 'skipped' },
      settle: { status: 'skipped', reason: 'project-not-found' },
    };
  }
  const delivery = await deliverDailyReview({
    projectId,
    slug: project.slug,
    fireId,
    at: new Date(),
  });
  if (delivery.kind === 'missed') {
    const refusal = { code: delivery.code, path: '', detail: delivery.detail };
    return {
      result: { ok: false, reason: 'rule-refused', status: 'skipped', refusal },
      settle: {
        status: 'skipped',
        reason: 'gate-refused',
        refusal: refusal.code,
        output: refusal.detail,
      },
    };
  }
  const output = delivery.published
    ? `the daily review brief was handed to master session ${delivery.sessionId}`
    : `the daily review brief waits in master session ${delivery.sessionId}'s inbox: its box was not reachable`;
  return {
    result: {
      ok: true,
      sessionId: delivery.sessionId,
      status: 'success',
      resolvedProjectId: projectId,
    },
    settle: { status: 'success', output },
  };
}
