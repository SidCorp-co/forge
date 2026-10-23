// Whom the steward's ask about an item goes to (REQ-48 BC-5, ISS-607): whoever can take the act the
// item waits on. A release approval is taken by a holder of `releases.approve`; where no account the
// project's master acts as holds it, the master is not asked, and the release holders are. Every
// other wait asks the master, as before.

import type { ItemStanding } from '@forge/contracts/steward';
import { innerActKey } from '../lib/standing-act-class.js';
import {
  actorFor,
  can,
  type NamedHolder,
  namedHolders,
  projectResource,
} from '../permissions/index.js';
import { stewardPorts } from './ports.js';

/** The acts a wait names that approve a release: an issue's, a requirement's and a carrier's. */
const RELEASE_APPROVAL_ACTS: ReadonlySet<string> = new Set([
  'issues.standing.act.approveOnReleases',
  'standing.act.approveReleaseV',
  'standing.act.approveCarrierRelease',
]);

export const APPROVE_RELEASE = 'releases.approve';

/** Whether the item waits on a release approval. */
export function waitsOnReleaseApproval(standing: Pick<ItemStanding, 'waitingOn'>): boolean {
  return RELEASE_APPROVAL_ACTS.has(innerActKey(standing.waitingOn));
}

export type AskAddressee =
  | { to: 'master' }
  | { to: 'release_holders'; holders: NamedHolder[] }
  | { to: 'nobody'; why: string };

/** Whether any account the project's master acts as may approve a release on the project. */
async function masterMayApprove(projectId: string): Promise<boolean> {
  const accounts = await stewardPorts().masterAccounts(projectId);
  for (const id of accounts) {
    if (await can(actorFor(id), APPROVE_RELEASE, projectResource(projectId))) return true;
  }
  return false;
}

/**
 * Whom an ask about an item with this standing goes to. A release approval the master may give is
 * the master's; one it may not is the release holders', the steward's own account never among them;
 * one nobody holds is nobody's, said by name.
 */
export async function askAddresseeOf(
  projectId: string,
  standing: Pick<ItemStanding, 'waitingOn'> | null,
  stewardId: string | null,
): Promise<AskAddressee> {
  if (!standing || !waitsOnReleaseApproval(standing)) return { to: 'master' };
  if (await masterMayApprove(projectId)) return { to: 'master' };
  const holders = (await namedHolders(APPROVE_RELEASE, projectId)).filter(
    (h) => h.id !== stewardId,
  );
  if (holders.length === 0) {
    return {
      to: 'nobody',
      why: `nobody on this project holds ${APPROVE_RELEASE}, the master included, so no one can approve the release; a project admin grants it`,
    };
  }
  return { to: 'release_holders', holders };
}
