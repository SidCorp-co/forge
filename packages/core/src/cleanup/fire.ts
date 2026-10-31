// What a cleanup window's fire does (REQ-79 BC-7), answered to the schedules module through its
// ports: nothing where the project turned fast delivery off or has nothing to clean, else the brief
// its cleanup run starts with. Whether a run is already live is the schedule's own read.

import { readFastDelivery } from '../project-config/index.js';
import type { CleanupFirePlan } from '../schedules/index.js';
import { cleanupBrief, FAST_DELIVERY_OFF_DETAIL } from './rules.js';
import { cleanupReportOwed, waitingIssues } from './service.js';
import { readDebts } from './store.js';

export async function cleanupFirePlan(args: {
  projectId: string;
  fireId: string;
}): Promise<CleanupFirePlan> {
  const { projectId, fireId } = args;
  if (!(await readFastDelivery(projectId))) return { kind: 'off', why: FAST_DELIVERY_OFF_DETAIL };
  const [debts, waiting, owed] = await Promise.all([
    readDebts(projectId),
    waitingIssues(projectId),
    cleanupReportOwed(projectId),
  ]);
  // a carried debt is no work for a run (BC-10), but a base owing a report before the next change
  // rated high lands is, whatever its debt: the window goes, and its report is green over carried debt
  if (debts.open.every((d) => d.carried) && waiting.length === 0 && !owed) {
    return {
      kind: 'nothing',
      why: `no cleanup debt is open but ${debts.open.length ? 'debt carried under a priced amnesty' : 'none'}, no change rated high waits on a cleanup, and the base owes no report, so this window starts no run`,
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
        carried: d.carried
          ? { trades: d.carried.trades, costs: d.carried.costs, endsWhen: d.carried.endsWhen }
          : null,
      })),
      waiting: waiting.map((w) => ({ key: w.issueKey, reason: w.impact.reason })),
    }),
  };
}
