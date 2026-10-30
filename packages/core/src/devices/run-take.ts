// Which issues a run declared on a box takes, by the role its master declared it as.

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { judgesOnly } from '../issues/index.js';

/**
 * The issues a run takes: each one it holds a lease on and restarts a step for. An issue that is over
 * (closed or dropped) is taken by no run. A run declared to judge — `qa` on the running build,
 * `reviewer` on a code property against the diff (`issues/issue-resting.ts:JUDGING_RUN_ROLES`) —
 * carries every issue that is over untaken, beside the work it does take, writes verdicts on it and
 * moves no status; a fail reopens it through the finding path (forge-core-61's ruling, 2026-10-29,
 * under `VISION: state-never-lies`: never reopen an issue so it can be judged). A run declared under
 * another role builds, so every issue it names is taken and one that is over is refused by name
 * (`issues/issue-resting.ts`). A run that names no role is the declaration before roles: a group
 * that is over throughout opens taking nothing (a release judge, ISS-576), and any other group is
 * taken whole. That reading is an amnesty for boxes whose `run declare` sends no role; it ends when
 * the runner refuses a declaration without `--role`.
 */
export function takenBy(
  canonical: { keys: readonly string[]; seqs: readonly number[] },
  statuses: Record<string, string>,
  role: string | undefined,
): { keys: string[]; seqs: number[] } {
  const over = (k: string) => {
    const status = statuses[k];
    return status !== undefined && (ISSUE_TERMINAL_STATUSES as readonly string[]).includes(status);
  };
  const keep = (pick: (k: string) => boolean) => {
    const keys: string[] = [];
    const seqs: number[] = [];
    canonical.keys.forEach((k, i) => {
      const seq = canonical.seqs[i];
      if (seq !== undefined && pick(k)) {
        keys.push(k);
        seqs.push(seq);
      }
    });
    return { keys, seqs };
  };
  if (role !== undefined && judgesOnly(role)) return keep((k) => !over(k));
  if (role === undefined && canonical.keys.length > 0 && canonical.keys.every(over)) {
    return { keys: [], seqs: [] };
  }
  return keep(() => true);
}
