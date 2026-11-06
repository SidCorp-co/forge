// Whom the steward's ask about an item goes to (REQ-48 BC-5, ISS-607, ISS-654): whoever takes the act
// the item waits on. A release approval the one rule keeps a person's is asked of the holders of
// `releases.approve`, by name, the steward's own account never among them; a feedback item's triage
// of the holders of `feedback.approve`, the master where an account it acts as holds that. Every
// other wait but a person's asks the master, as before. A release's naming is such an act too
// (ISS-590): it takes project.admin (`release-batch/naming.ts:nameReleaseAs`), so the release names
// its namer the same way, `releaseNamerOf`.
// A wait a person owes (a park's answer, a design re-pin) is that person's, read on their Needs you,
// unless the one rule gives its act to the master: Needs you leaves such an act to the master
// (REQ-68 BC-3), so the steward asks the master it, by the rule both read (`ports.ts:masterTakes`,
// ISS-758). Otherwise the master is not asked it (ISS-739).
// ISS-1058: who owes an act is the one rule's (`@forge/contracts/who-owes:whoOwes`), never the grant
// of the account the master acts as: a release approval the project's policy keeps a person's is asked
// of its holders by name, the master never, whatever its account holds; one the rule gives the master
// is the master's. A wait on a person naming a routine release act (a cut, a record) asks the master
// (`ports.ts:masterTakes`). A triage is the gate's (`person-gates.ts`, triage): the holders of
// feedback.approve, an agent holding it alike, so the master is asked it where its account holds that.
// An issue that waits on a person's answer to its open question (kind `answer`) is asked nobody and
// no master: the ask is that question itself, placed on the item the issue serves, so it reaches a
// person as a decision on that item in Needs you (REQ-68 BC-4; `questions/on-item.ts`). Round 2 of
// ISS-687 turned that wait from `person` to `answer`, and the steward then woke the master about a
// question only a person answers, where before it had logged "asked nobody, act on the item yourself".

import type { ProjectPermission } from '@forge/contracts/permissions';
import type { ReleaseNamer } from '@forge/contracts/release-naming';
import type { WaitingKind } from '@forge/contracts/standing';
import type { ItemStanding } from '@forge/contracts/steward';
import { FEEDBACK_TRIAGE_ACTS } from '@forge/contracts/steward';
import { type OwedBy, owedActOfSaid, whoOwes } from '@forge/contracts/who-owes';
import { innerActKey } from '../lib/standing-act-class.js';
import { holds, masterFactsOf, type NamedHolder, namedHolders } from '../permissions/index.js';
import { readOwedPolicy } from '../project-config/index.js';
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
  // a person's answer is no master's act: the master answers no question a person owes
  if (standing.waitingOn.kind === 'answer') return true;
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

/**
 * Whom an ask goes to: whoever takes the act, the person a wait names, whose act it is (ISS-739), or,
 * for an issue waiting on a person's answer, the item that issue serves, where the question is asked.
 */
export type AskAddressee =
  | ActAddressee
  | { to: 'person'; who: string; act: string }
  | { to: 'item'; issueId: string };

/** Whether the item is an issue waiting on a person's answer to its question (`issues/standing.ts:answerTurn`). */
export const waitsOnAnswer = (standing: Pick<ItemStanding, 'waitingOn' | 'subject'>): boolean =>
  standing.subject.kind === 'issue' && standing.waitingOn.kind === 'answer';

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
    // its pane writes as an agent, so outside strict it holds the master's grant (REQ-79 r6 BC-11)
    if (holds(await masterFactsOf(id, projectId, 'agent'), permission)) {
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
 * Whom an ask about an item with this standing goes to. An issue's answer a person owes is asked on
 * the item the issue serves. A held act the master may take is the master's; one it may not is its holders', the steward's own account never among them; one nobody
 * holds is nobody's, said by name. Any other act a person owes is that person's, never the master's,
 * unless the master's account holds what it asks (ISS-758).
 */
export async function askAddresseeOf(
  projectId: string,
  standing: Pick<ItemStanding, 'waitingOn' | 'subject'> | null,
  stewardId: string | null,
): Promise<AskAddressee> {
  if (standing && waitsOnAnswer(standing)) return { to: 'item', issueId: standing.subject.id };
  const act = heldActOf(standing);
  if (act && standing) {
    const owed = await owedByRule(projectId, standing);
    if (owed?.by === 'master') return { to: 'master' };
    // a person's by the rule: its holders, whatever the master's account holds
    return addresseeOfAct(projectId, act, stewardId, { masterByGrant: owed === null });
  }
  if (standing && (await waitsOnPerson(projectId, standing))) {
    return { to: 'person', who: standing.waitingOn.who, act: standing.waitingOn.act };
  }
  return { to: 'master' };
}

/**
 * Who owes the held act a wait names by the one rule, or null where the table does not hold it (a
 * triage, which its gate gives the holders of feedback.approve). Read with the project's policy:
 * the wait carries no release's content, and an approval a wait names is one the policy requires.
 */
async function owedByRule(
  projectId: string,
  standing: Pick<ItemStanding, 'waitingOn'>,
): Promise<OwedBy | null> {
  const kind = owedActOfSaid(innerActKey(standing.waitingOn));
  return kind ? whoOwes(kind, await readOwedPolicy(projectId)) : null;
}

/**
 * Whom an act only `act.permission`'s holders take goes to: the master, its holders by name, or
 * nobody. `masterByGrant: false` where the one rule keeps the act a person's: the master is not asked
 * it whatever its account holds, and its holders are the people who hold the permission.
 */
export async function addresseeOfAct(
  projectId: string,
  act: HeldAct,
  stewardId: string | null,
  opts: { masterByGrant?: boolean } = {},
): Promise<ActAddressee> {
  const byGrant = opts.masterByGrant !== false;
  const master = byGrant
    ? await masterStanding(projectId, act.permission)
    : { holds: false, unread: [] };
  if (master.holds) return { to: 'master' };
  const { unread } = master;
  const holders = (await namedHolders(act.permission, projectId)).filter((h) => h.id !== stewardId);
  if (holders.length === 0) {
    const masterToo = byGrant && unread.length === 0 ? ', the master included' : '';
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
