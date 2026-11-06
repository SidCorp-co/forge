/**
 * The release that still holds an act before an issue at the release gate ships, as the release list
 * reads it (`release-read.ts:listReleases`): its version, its state and its own standing, whom it
 * waits on and for what. The steward's facts and its asks read it (ISS-1040): an issue whose every
 * criterion is earned on a project with production owes nothing of its own, and the act that ships
 * it (cut, approve, promote) is that release's, raised once on the release and never per issue.
 */

import type { ReleaseState, ReleaseSummary } from '@forge/contracts/releases';
import type { WaitingOn } from '@forge/contracts/standing';
import { listReleases } from './release-read.js';

/** A release that has not shipped yet, and the wait its own standing reads. */
export interface HoldingRelease {
  version: string;
  state: ReleaseState;
  /** Whom it waits on and for what, as its page says it. */
  waitingOn: WaitingOn;
  /** When it last changed, as its page reads it (`release-read-views.ts:lastChange`): since when it has waited so. */
  since: string;
  /** Its wait in one line (`releaseWaitLine`), which an ask on it is keyed on. */
  line: string;
}

/** Whether the release still holds an act: neither shipped, nor delivered on its branch, nor stopped. */
const holds = (r: Pick<ReleaseSummary, 'attentionGroup'>) =>
  r.attentionGroup !== 'done' && r.attentionGroup !== 'stopped';

const carries = (r: Pick<ReleaseSummary, 'contents'>, issueId: string) =>
  r.contents.some((g) => g.issues.some((i) => i.id === issueId));

const holdingOf = (r: ReleaseSummary): HoldingRelease => ({
  version: r.version,
  state: r.state,
  waitingOn: r.waitingOn,
  since: r.at,
  line: releaseWaitLine(r),
});

/** The release not yet shipped whose roster carries the issue, or null where none does. */
export async function carryingReleaseOf(
  projectId: string,
  issueId: string,
): Promise<HoldingRelease | null> {
  const { releases } = await listReleases(projectId, null);
  const hit = releases.find((r) => holds(r) && carries(r, issueId));
  return hit ? holdingOf(hit) : null;
}

/** The release `version` names while it has not shipped, or null once it shipped, stopped or is gone. */
export async function holdingReleaseOf(
  projectId: string,
  version: string,
): Promise<HoldingRelease | null> {
  const { releases } = await listReleases(projectId, null);
  const hit = releases.find((r) => r.version === version && holds(r));
  return hit ? holdingOf(hit) : null;
}

/**
 * The release's wait in one line, `release 0.14.0 (draft) waits on Master to open the promotion
 * change request at a judged head`: what an ask on the release is keyed on, so it is raised once
 * while the line reads the same.
 */
export function releaseWaitLine(
  r: Pick<ReleaseSummary, 'version' | 'state' | 'waitingOn'>,
): string {
  const owes = r.waitingOn.act ? ` to ${r.waitingOn.act}` : '';
  return `release ${r.version} (${r.state.replace('_', ' ')}) waits on ${r.waitingOn.who}${owes}`;
}
