// The `beta_port` schedule branch (ISS-923): core ports forge-beta's issues to their same-slug
// projects here and mirrors each ported pair's status back (`beta-port/run.ts`). It starts no
// session and reaches no box. What core holds itself is checked before the fire is answered: a
// missing secret, a missing ruling or a fire of the same project still running is refused there and
// settled skipped naming why. The beta reads and writes run after the answer (a fire took 74 s), and
// settle the fire with its report, skipped with a refusal where beta could not be read, or failed.

import { and, eq, lt, ne, sql } from 'drizzle-orm';
import { startBetaPort } from '../beta-port/index.js';
import { db } from '../db/client.js';
import { scheduleRuns, schedules } from '../db/schema.js';
import type { DispatchScheduleInput, RoutedFire } from './dispatch-types.js';
import { type FireSettlement, settleFire } from './fires.js';

/** A beta port fire still running this long after it started is one whose core stopped under it. */
export const BETA_PORT_FIRE_STALE_MS = 60 * 60 * 1000;

const ofBetaPort = (projectId: string, fireId: string) =>
  and(
    eq(scheduleRuns.projectId, projectId),
    eq(schedules.kind, 'beta_port'),
    eq(scheduleRuns.status, 'running'),
    ne(scheduleRuns.id, fireId),
    sql`${scheduleRuns.sessionId} IS NULL`,
  );

/**
 * Another beta port fire of this project still running, after settling `failed` every one that has
 * run past the stale bound: its core stopped before it settled, and it would otherwise hold every
 * later fire off forever. Two fires at once would each port the same beta issue.
 */
async function liveBetaPortFire(projectId: string, fireId: string): Promise<string | null> {
  const staleBefore = new Date(Date.now() - BETA_PORT_FIRE_STALE_MS);
  const stale = await db
    .select({ id: scheduleRuns.id })
    .from(scheduleRuns)
    .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
    .where(and(ofBetaPort(projectId, fireId), lt(scheduleRuns.startedAt, staleBefore)));
  for (const { id } of stale) {
    await settleFire(id, {
      status: 'failed',
      error: `still running ${BETA_PORT_FIRE_STALE_MS / 60_000} minutes after it started: the core running it stopped before it settled, and fire ${fireId} ended it`,
    });
  }
  const [live] = await db
    .select({ id: scheduleRuns.id })
    .from(scheduleRuns)
    .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
    .where(ofBetaPort(projectId, fireId))
    .limit(1);
  return live?.id ?? null;
}

const refused = (code: string, detail: string): RoutedFire => {
  const refusal = { code, path: '', detail };
  return {
    result: { ok: false, reason: 'rule-refused', status: 'skipped', refusal },
    settle: { status: 'skipped', reason: 'gate-refused', refusal: code, output: detail },
  };
};

export async function routeScheduleBetaPortFire(
  input: DispatchScheduleInput,
  fireId: string,
): Promise<RoutedFire> {
  const { projectId } = input.schedule;
  const live = await liveBetaPortFire(projectId, fireId);
  if (live) {
    return refused(
      'BETA_PORT_FIRE_LIVE',
      `beta port fire ${live} of this project is still running, and two at once would port the same beta issue twice: this fire starts nothing; its report is at GET /api/projects/${projectId}/automation/fires/${live}`,
    );
  }
  const start = await startBetaPort({ projectId, fireId });
  if (start.kind === 'refused') return refused(start.code, start.detail);
  return {
    result: { ok: true, sessionId: null, status: 'running', resolvedProjectId: projectId },
    settle: null,
    background: async (): Promise<FireSettlement> => {
      const outcome = await start.run();
      if (outcome.kind === 'failed') return { status: 'failed', error: outcome.error };
      if (outcome.kind === 'refused') {
        return {
          status: 'skipped',
          reason: 'gate-refused',
          refusal: outcome.code,
          output: outcome.detail,
        };
      }
      if (!outcome.changed) {
        return { status: 'skipped', reason: 'nothing-to-do', output: outcome.output };
      }
      return { status: 'success', output: outcome.output };
    },
  };
}
