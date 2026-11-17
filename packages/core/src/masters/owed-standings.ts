import { agrees } from '../lib/plural.js';
import { decisionDoors } from './decision-doors.js';
import type { StandingActOwed } from './ports.js';

/**
 * ISS-1278: every open issue, requirement, feedback item and workflow whose standing waits on the
 * master is yours, named with its act; the standing read holds what each one is. ISS-1282: a wait
 * the master keeps is recorded at the decision door of the item's own kind, each kind listed named
 * with its door, so a requirement's is never written on the issue delivering it, where nothing
 * reads it; one with a date or a condition holds the item off this list (`standing/master-owed.ts`).
 */
export function standingActsLine(acts: readonly StandingActOwed[]): string {
  if (acts.length === 0) return '';
  const named = acts.map((a) => `${a.subject.key}: ${a.act}`).join('; ');
  const doors = decisionDoors(acts.map((a) => a.subject));
  return ` ${acts.length} item${agrees(acts.length, '', 's')} ${agrees(acts.length, 'waits', 'wait')} on you by ${agrees(acts.length, 'its', 'their')} standing (${named}): read each standing (\`forge-runner api projects/<projectId>/standings\`, its \`waitingOn\` names the act and its rule) and take the act, or record why it waits as a decision on the item, at its own door: ${doors.join('; ')} (other text there is a condition, held while its standing waits on the same act); a decision with a date to come or a condition takes the item off this list, one with neither leaves it listed.`;
}

/** Each act's identity in the work digest: the item and the act, so a new act on it moves the digest. */
export const standingActsWork = (acts: readonly StandingActOwed[]): string[] =>
  acts.map((a) => `standing-act:${a.subject.kind}:${a.subject.id}|${a.key}`);

/**
 * Acts that admit a requirement: proposing an agent's draft, revising a returned one, accepting a
 * proposed revision. Where the project's gate `master_admitted_only` is enforced the master works
 * admitted items only, so none of these is its work (REQ-76 BC-9, REQ-79 r6); where it is off each
 * is, as the requirement's standing says (`requirements/standing-draft.ts:draftTurn`).
 */
const ADMISSION_ACTS: ReadonlySet<string> = new Set([
  'standing.act.proposeOrDrop',
  'standing.act.reviseThenProposeOrDrop',
  'standing.act.acceptR',
]);

/** The owed lists that name an item's own standing act: an item one of them names is named there, once. */
export type NamingLists = Record<string, readonly object[]>;

const ID_FIELDS = ['key', 'issueId', 'workflowId', 'feedbackId'] as const;

function namedIn(lists: NamingLists): Set<string> {
  const named = new Set<string>();
  for (const item of Object.values(lists).flat()) {
    for (const field of ID_FIELDS) {
      const value = (item as Record<string, unknown>)[field];
      if (typeof value === 'string') named.add(value);
    }
  }
  return named;
}

/**
 * The standing acts the master owes this sweep: every one but an admission where the gate keeps the
 * master to admitted items, and one whose item a list of its own already names (ISS-840: a carrier
 * is named once, as the carrier it is).
 */
export function standingActsDue(
  acts: readonly StandingActOwed[],
  admittedOnly: boolean,
  lists: NamingLists,
): StandingActOwed[] {
  const named = namedIn(lists);
  return acts.filter(
    (a) =>
      !(admittedOnly && ADMISSION_ACTS.has(a.key)) &&
      !named.has(a.subject.key) &&
      !named.has(a.subject.id),
  );
}
