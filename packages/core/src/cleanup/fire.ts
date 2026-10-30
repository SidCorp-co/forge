// What a cleanup window's fire does (REQ-79 BC-7), answered to the schedules module through its
// ports: nothing where the project turned fast delivery off or has nothing to clean, else the brief
// its cleanup run starts with. Whether a run is already live is the schedule's own read.

import type { CleanupFirePlan } from '../schedules/index.js';
import { FAST_DELIVERY_OFF_DETAIL, cleanupBrief } from './rules.js';
import { readFastDelivery } from '../project-config/index.js';
import { readDebts } from './store.js';
import { waitingIssues } from './service.js';

export async function cleanupFirePlan(args: {
  projectId: string;
  fireId: string;
}): Promise<CleanupFirePlan> {
  const { projectId, fireId } = args;
  if (!(await readFastDelivery(projectId))) return { kind: 'off', why: FAST_DELIVERY_OFF_DETAIL };
  const [debts, waiting] = await Promise.all([readDebts(projectId), waitingIssues(projectId)]);
  if (debts.open.length === 0 && waiting.length === 0) {
    return {
      kind: 'nothing',
      why: 'no cleanup debt is open and no change rated high waits on a cleanup, so this window starts no run',
    };
  }
  return {
    kind: 'run',
    prompt: cleanupBrief({
      projectId,
      fireId,
      debts: debts.open.map((d) => ({
        id: d.id,
        kind: d.kind,
        check: d.check,
        where: d.where,
        rating: d.impact.rating,
        issueKey: d.issueKey,
      })),
      waiting: waiting.map((w) => ({ key: w.issueKey, reason: w.impact.reason })),
    }),
  };
}
