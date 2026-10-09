/**
 * An issue born asking `open` is admitted through the same move a draft takes (Issue lifecycle r15
 * start, ready-check; REQ-34 BC-2): it is written at `draft`, then moved to `open` by the kernel,
 * which judges the issue-ready checklist and the admit guard (`approvals.admit`). A gap leaves it at
 * `draft`, and the answer names each refusal that held it, so no door opens an issue the checklist
 * would hold and none is told it opened when it did not.
 */

import type { Refusal } from '../lib/refusal.js';
import { RefusalError } from '../lib/refusal.js';
import type { TransitionActor } from './actor-agency.js';
import { transitionIssueStatus } from './apply-transition.js';

/** Where an issue born asking `open` stands: opened, or held at draft by each refusal named. */
export interface Admission {
  status: 'open' | 'draft';
  refusals: Refusal[];
}

export async function admitBorn(
  issue: { id: string; projectId: string; reopenCount: number },
  actor: TransitionActor,
  reason: string,
): Promise<Admission> {
  try {
    await transitionIssueStatus({ ...issue, status: 'draft' }, 'open', actor, { reason });
    return { status: 'open', refusals: [] };
  } catch (err) {
    if (err instanceof RefusalError) return { status: 'draft', refusals: [...err.refusals] };
    throw err;
  }
}
