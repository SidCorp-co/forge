// What a cleanup window's fire does (REQ-79 BC-7, BC-20), answered to the schedules module through
// its ports: nothing where the project turned fast delivery off or has nothing to clean or review,
// a refusal where what landed cannot be read and nothing else is owed, else the brief its cleanup run
// starts with. Whether a run is already live is the schedule's own read.

import { readFastDelivery } from '../project-config/index.js';
import type { CleanupFirePlan } from '../schedules/index.js';
import { landedSinceReport } from './landed.js';
import { cleanupBrief, FAST_DELIVERY_OFF_DETAIL, landedWords } from './rules.js';
import { cleanupReportOwed, waitingIssues } from './service.js';
import { readDebts, userNames } from './store.js';

export async function cleanupFirePlan(args: {
  projectId: string;
  fireId: string;
}): Promise<CleanupFirePlan> {
  const { projectId, fireId } = args;
  if (!(await readFastDelivery(projectId))) return { kind: 'off', why: FAST_DELIVERY_OFF_DETAIL };
  const [debts, waiting, owed, landed] = await Promise.all([
    readDebts(projectId),
    waitingIssues(projectId),
    cleanupReportOwed(projectId),
    landedSinceReport(projectId),
  ]);
  // a carried debt is no work for a run (BC-10), but a base owing a report before the next change
  // rated high lands is, whatever its debt: the window goes, and its report is green over carried
  // debt; and so is anything that landed since the last report, which the run reviews (BC-20)
  const idle = debts.open.every((d) => d.carried) && waiting.length === 0 && !owed;
  if (idle && landed.kind === 'unread') return { kind: 'unread', why: landed.why };
  if (idle && landed.kind !== 'landed') {
    return {
      kind: 'nothing',
      why: `no cleanup debt is open but ${debts.open.length ? 'debt carried under a priced amnesty' : 'none'}, no change rated high waits on a cleanup, the base owes no report, and ${landedWords(landed)}, so this window starts no run`,
    };
  }
  const names = await userNames(
    debts.open.flatMap((d) => [
      ...(d.carried?.by ? [d.carried.by] : []),
      ...d.evidence.flatMap((e) => (e.by ? [e.by] : [])),
    ]),
  );
  const named = (id: string | null) => (id ? (names.get(id) ?? null) : null);
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
        detail: d.detail,
        carried: d.carried
          ? {
              trades: d.carried.trades,
              costs: d.carried.costs,
              endsWhen: d.carried.endsWhen,
              by: named(d.carried.by),
            }
          : null,
        evidence: d.evidence.map((e) => ({ evidence: e.evidence, by: named(e.by), at: e.at })),
      })),
      waiting: waiting.map((w) => ({ key: w.issueKey, reason: w.impact.reason })),
      landed,
    }),
  };
}
