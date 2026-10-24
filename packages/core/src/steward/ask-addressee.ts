// Whom the steward's ask about an item goes to (REQ-48 BC-5, ISS-607, ISS-654): whoever can take the
// act the item waits on. A release approval is taken by a holder of `releases.approve`, a feedback
// item's triage by a holder of `feedback.approve`; where no account the project's master acts as
// holds that permission, the master is not asked, and the holders are, by name, the steward's own
// account never among them. Every other wait asks the master, as before. A release's naming is such
// an act too (ISS-590): it takes project.admin (`release-batch/naming.ts:nameReleaseAs`), so the
// release names its namer the same way, `releaseNamerOf`.

import type { ProjectPermission } from '@forge/contracts/permissions';
import type { ReleaseNamer } from '@forge/contracts/release-naming';
import type { ItemStanding } from '@forge/contracts/steward';
import { FEEDBACK_TRIAGE_ACTS } from '@forge/contracts/steward';
import { innerActKey } from '../lib/standing-act-class.js';
import {
  actorFor,
  can,
  type NamedHolder,
  namedHolders,
  projectResource,
} from '../permissions/index.js';
import { heldStewardOf } from './account.js';
import { stewardPorts } from './ports.js';

/** The acts a wait names that approve a release: an issue's, a requirement's and a carrier's. */
const RELEASE_APPROVAL_ACTS: ReadonlySet<string> = new Set([
  'issues.standing.act.approveOnReleases',
  'standing.act.approveReleaseV',
  'standing.act.approveCarrierRelease',
]);

export const APPROVE_RELEASE = 'releases.approve';
export const APPROVE_FEEDBACK = 'feedback.approve';

/** An act a wait names that only the holders of one permission take, and what taking it is called. */
export interface HeldAct {
  permission: ProjectPermission;
  /** The act, as a notice's title and a refusal say it. */
  what: string;
  /** The door an ask of its holders is logged under. */
  door: string;
}

const HELD_ACTS: readonly (HeldAct & { acts: ReadonlySet<string> })[] = [
  {
    acts: RELEASE_APPROVAL_ACTS,
    permission: APPROVE_RELEASE,
    what: 'release approval',
    door: 'NOTIFY release holders',
  },
  {
    acts: new Set(FEEDBACK_TRIAGE_ACTS),
    permission: APPROVE_FEEDBACK,
    what: 'triage',
    door: 'NOTIFY feedback holders',
  },
];

/** Naming a release: the act no standing waits on, which a release's unnamed state owes (ISS-590). */
export const RELEASE_NAMING: HeldAct = {
  permission: 'project.admin',
  what: 'release naming',
  door: 'NOTIFY release namers',
};

/** The held act the item waits on, or null where it waits on one the master is asked about. */
export function heldActOf(standing: Pick<ItemStanding, 'waitingOn'> | null): HeldAct | null {
  if (!standing) return null;
  const key = innerActKey(standing.waitingOn);
  const hit = HELD_ACTS.find((h) => h.acts.has(key));
  return hit ? { permission: hit.permission, what: hit.what, door: hit.door } : null;
}

/** Whether the item waits on a release approval. */
export function waitsOnReleaseApproval(standing: Pick<ItemStanding, 'waitingOn'>): boolean {
  return heldActOf(standing)?.permission === APPROVE_RELEASE;
}

export type AskAddressee =
  | { to: 'master' }
  | { to: 'holders'; act: HeldAct; holders: NamedHolder[] }
  | { to: 'nobody'; act: HeldAct; why: string };

/** Whether any account the project's master acts as holds `permission` on the project. */
async function masterHolds(projectId: string, permission: ProjectPermission): Promise<boolean> {
  const accounts = await stewardPorts().masterAccounts(projectId);
  for (const id of accounts) {
    if (await can(actorFor(id), permission, projectResource(projectId))) return true;
  }
  return false;
}

/**
 * Whom an ask about an item with this standing goes to. A held act the master may take is the
 * master's; one it may not is its holders', the steward's own account never among them; one nobody
 * holds is nobody's, said by name.
 */
export async function askAddresseeOf(
  projectId: string,
  standing: Pick<ItemStanding, 'waitingOn'> | null,
  stewardId: string | null,
): Promise<AskAddressee> {
  const act = heldActOf(standing);
  return act ? addresseeOfAct(projectId, act, stewardId) : { to: 'master' };
}

/** Whom an act only `act.permission`'s holders take goes to: the master, its holders by name, or nobody. */
export async function addresseeOfAct(
  projectId: string,
  act: HeldAct,
  stewardId: string | null,
): Promise<AskAddressee> {
  if (await masterHolds(projectId, act.permission)) return { to: 'master' };
  const holders = (await namedHolders(act.permission, projectId)).filter((h) => h.id !== stewardId);
  if (holders.length === 0) {
    return {
      to: 'nobody',
      act,
      why: `nobody on this project holds ${act.permission}, the master included, so no one can take the ${act.what}; a project admin grants it`,
    };
  }
  return { to: 'holders', act, holders };
}

/** Who names the project's unnamed releases, as a release's page says it. */
export async function releaseNamerOf(projectId: string): Promise<ReleaseNamer> {
  const to = await addresseeOfAct(projectId, RELEASE_NAMING, await heldStewardOf(projectId));
  if (to.to === 'holders') return { to: 'admins', names: to.holders.map((h) => h.name) };
  return { to: to.to };
}
