// Whom the steward's ask about an item goes to (REQ-48 BC-5, ISS-607, ISS-654): whoever can take the
// act the item waits on. A release approval is taken by a holder of `releases.approve`, a feedback
// item's triage by a holder of `feedback.approve`; where no account the project's master acts as
// holds that permission, the master is not asked, and the holders are, by name, the steward's own
// account never among them. Every other wait but a person's asks the master, as before. A release's naming is such
// an act too (ISS-590): it takes project.admin (`release-batch/naming.ts:nameReleaseAs`), so the
// release names its namer the same way, `releaseNamerOf`.
// A wait a person owes (a park's answer, a design re-pin) is that person's, read on their Needs you,
// unless the master's account holds what the act asks: Needs you leaves such an act to the master
// (REQ-68 BC-3), so the steward asks the master it, by the one rule both read, `masterTakesWait`
// (ISS-758). Otherwise the master's account does not take a person's act for them
// (`permissions/holders-named.ts`), so the master is not asked it (ISS-739).

import type { ProjectPermission } from '@forge/contracts/permissions';
import type { ReleaseNamer } from '@forge/contracts/release-naming';
import type { WaitingKind } from '@forge/contracts/standing';
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

/** The waits a person owes: the master's agent account does not take their act for them. */
const PERSON_WAITS: ReadonlySet<WaitingKind> = new Set(['you', 'person', 'admins', 'writers']);

/**
 * Whether the item waits on a person's own act: a wait on a person that is no held act (a release
 * approval, a triage: those the master takes where it holds the permission) and no act the master
 * takes (`masterTakesWait`, the rule Needs you leaves a row to the master by).
 */
export async function waitsOnPerson(
  projectId: string,
  standing: Pick<ItemStanding, 'waitingOn'>,
): Promise<boolean> {
  if (!PERSON_WAITS.has(standing.waitingOn.kind) || heldActOf(standing) !== null) return false;
  return !(await stewardPorts().masterTakes(projectId, standing.waitingOn.says.act));
}

/** Whether the item waits on a release approval. */
export function waitsOnReleaseApproval(standing: Pick<ItemStanding, 'waitingOn'>): boolean {
  return heldActOf(standing)?.permission === APPROVE_RELEASE;
}

/**
 * Whom an ask goes to. `unread` names the serving boxes whose account the master's pane acts as
 * cannot be read (its checkout carries no credential), so the master there is not taken to hold the
 * act; `unreadLine` says so in the words an act or the item's line carries.
 */
export type ActAddressee =
  | { to: 'master' }
  | { to: 'holders'; act: HeldAct; holders: NamedHolder[]; unread: string[] }
  | { to: 'nobody'; act: HeldAct; why: string; unread: string[] };

/** Whom an ask goes to: whoever takes the act, or the person a wait names, whose act it is (ISS-739). */
export type AskAddressee = ActAddressee | { to: 'person'; who: string; act: string };

/**
 * Whether an account the project's master acts as holds `permission` on the project, and the serving
 * boxes whose account is unread. Only an account its pane writes under counts (ISS-590): the person
 * who paired a box is not one, however much that person may do.
 */
async function masterStanding(
  projectId: string,
  permission: ProjectPermission,
): Promise<{ holds: boolean; unread: string[] }> {
  const { accounts, unread } = await stewardPorts().masterAccounts(projectId);
  for (const id of accounts) {
    if (await can(actorFor(id), permission, projectResource(projectId))) {
      return { holds: true, unread };
    }
  }
  return { holds: false, unread };
}

/** The line saying which serving boxes' master account is unread, or '' where none is. */
export function unreadLine(unread: readonly string[]): string {
  if (unread.length === 0) return '';
  return `the account the master acts as on box ${unread.join(', ')} is unread (its checkout carries no live credential), so it is not taken to hold it`;
}

/**
 * Whom an ask about an item with this standing goes to. A held act the master may take is the
 * master's; one it may not is its holders', the steward's own account never among them; one nobody
 * holds is nobody's, said by name. Any other act a person owes is that person's, never the master's,
 * unless the master's account holds what it asks (ISS-758).
 */
export async function askAddresseeOf(
  projectId: string,
  standing: Pick<ItemStanding, 'waitingOn'> | null,
  stewardId: string | null,
): Promise<AskAddressee> {
  const act = heldActOf(standing);
  if (act) return addresseeOfAct(projectId, act, stewardId);
  if (standing && (await waitsOnPerson(projectId, standing))) {
    return { to: 'person', who: standing.waitingOn.who, act: standing.waitingOn.act };
  }
  return { to: 'master' };
}

/** Whom an act only `act.permission`'s holders take goes to: the master, its holders by name, or nobody. */
export async function addresseeOfAct(
  projectId: string,
  act: HeldAct,
  stewardId: string | null,
): Promise<ActAddressee> {
  const master = await masterStanding(projectId, act.permission);
  if (master.holds) return { to: 'master' };
  const { unread } = master;
  const holders = (await namedHolders(act.permission, projectId)).filter((h) => h.id !== stewardId);
  if (holders.length === 0) {
    const masterToo = unread.length === 0 ? ', the master included' : '';
    const unreadToo = unread.length === 0 ? '' : `; ${unreadLine(unread)}`;
    return {
      to: 'nobody',
      act,
      why: `nobody on this project holds ${act.permission}${masterToo}, so no one can take the ${act.what}; a project admin grants it${unreadToo}`,
      unread,
    };
  }
  return { to: 'holders', act, holders, unread };
}

/** Who names the project's unnamed releases, as a release's page says it. */
export async function releaseNamerOf(projectId: string): Promise<ReleaseNamer> {
  const to = await addresseeOfAct(projectId, RELEASE_NAMING, await heldStewardOf(projectId));
  if (to.to === 'holders') return { to: 'admins', names: to.holders.map((h) => h.name) };
  return { to: to.to };
}
