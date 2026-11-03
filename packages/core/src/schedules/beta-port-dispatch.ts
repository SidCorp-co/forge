// The `beta_port` schedule branch (ISS-923): core ports forge-beta's issues to their same-slug
// projects here and mirrors each ported pair's status back (`beta-port/run.ts`). It starts no
// session and reaches no box. A fire that could not start (a missing secret, an unreadable beta) is
// settled skipped with the refusal naming why; a fire that ran is settled with its report.

import { runBetaPort } from '../beta-port/index.js';
import type { DispatchScheduleInput, RoutedFire } from './dispatch-types.js';

export async function routeScheduleBetaPortFire(
  input: DispatchScheduleInput,
  fireId: string,
): Promise<RoutedFire> {
  const { projectId } = input.schedule;
  const outcome = await runBetaPort({ projectId, fireId });
  if (outcome.kind === 'refused') {
    const refusal = { code: outcome.code, path: '', detail: outcome.detail };
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
  if (!outcome.changed) {
    return {
      result: { ok: true, sessionId: null, status: 'skipped', resolvedProjectId: projectId },
      settle: { status: 'skipped', reason: 'nothing-to-do', output: outcome.output },
    };
  }
  return {
    result: { ok: true, sessionId: null, status: 'success', resolvedProjectId: projectId },
    settle: { status: 'success', output: outcome.output },
  };
}
