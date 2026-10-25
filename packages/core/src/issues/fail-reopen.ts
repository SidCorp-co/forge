// A failing verdict reopens the issue that owns the work, never a new one (REQ-74 BC-3, REQ-45 BC-2,
// ISS-598). Every door that writes a fail carries it on `verdict.recorded` in its own transaction
// (`criteria/verdict-record.ts:recordVerdict`, and the requirement verdict for the issue that
// delivered the criterion), and this consumer moves that issue to `reopen` where it is past its
// build: at `awaiting_release` or `closed`. One still being built or parked is already somebody's
// work and is left where it is. A move the machine refuses (a running release claims the issue, or it
// is archived) is said on the issue by name, never dropped.

import { ISSUE_RESOLVED_STATUSES } from '@forge/contracts/issue-machine';
import type { VerdictFailed } from '@forge/contracts/outbox-events';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, issues } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { RefusalError } from '../lib/refusal.js';
import { consume } from '../outbox/index.js';
import type { TransitionActor } from './actor-agency.js';
import { transitionIssueStatus } from './apply-transition.js';
import { postIssueNotice } from './ports.js';

type Failed = VerdictFailed & { issueId: string; verdictId: string };

/** The statuses past an issue's build, where a fail sends it back: its work is resolved. */
const PAST_BUILD: ReadonlySet<string> = new Set(ISSUE_RESOLVED_STATUSES);

function failedWhat(p: Failed): string {
  const what = p.requirement
    ? `${p.requirement}, which this issue delivered, was judged fail at its requirement`
    : `criterion ${p.criterion} was judged fail`;
  return `${what} (verdict ${p.verdictId})${p.reason ? `: ${p.reason}` : ''}`;
}

/** Who recorded the fail moves the issue: its account, else its box, else the issue's author. */
async function actorOf(p: Failed, fallback: string): Promise<TransitionActor> {
  if (p.authorUserId) return { type: 'user', id: p.authorUserId, agency: p.agency };
  if (p.authorDeviceId) {
    const [d] = await db
      .select({ ownerId: devices.ownerId })
      .from(devices)
      .where(eq(devices.id, p.authorDeviceId))
      .limit(1);
    if (d) return { type: 'device', id: p.authorDeviceId, ownerId: d.ownerId };
  }
  return { type: 'user', id: fallback, agency: p.agency };
}

/** Send the issue a fail names back to `reopen`, or say on it why it stays. */
export async function reopenOnFail(p: Failed): Promise<void> {
  const [row] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      createdById: issues.createdById,
    })
    .from(issues)
    .where(eq(issues.id, p.issueId))
    .limit(1);
  if (!row || !PAST_BUILD.has(row.status)) return;
  const actor = await actorOf(p, row.createdById);
  try {
    await transitionIssueStatus(row, 'reopen', actor, {
      transitionReason: `${failedWhat(p)}. A failing verdict reopens the issue that owns the work: correct it here, not in a new issue.`,
    });
  } catch (err) {
    if (!(err instanceof RefusalError)) throw err;
    const [refusal] = err.refusals;
    logger.warn({ issueId: p.issueId, code: refusal?.code }, 'a failing verdict could not reopen');
    await postIssueNotice({
      issueId: p.issueId,
      authorId: actor.type === 'user' ? actor.id : actor.ownerId,
      body: `${failedWhat(p)}, and it stays at \`${row.status}\`: the move to \`reopen\` was refused (${refusal?.code ?? err.fallbackCode}: ${refusal?.detail ?? err.message}).`,
    });
  }
}

export function registerFailReopen(): void {
  consume('verdict.recorded', {
    name: 'issue-fail-reopen',
    handle: async (p) => {
      if (p.failed) await reopenOnFail({ ...p.failed, issueId: p.issueId, verdictId: p.verdictId });
    },
  });
}
