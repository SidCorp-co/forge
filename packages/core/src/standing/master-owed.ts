/**
 * The acts the project's open issues, requirements, feedback items and workflows wait on its master
 * for (ISS-1278): the one standing read (`read.ts:openStandings`), each wait passing the one test of
 * naming the master (`lib/master-wait.ts:waitNamesMaster`) that the releases' read applies too.
 * Placement and retirement count each as owed work (`masters/verdict.ts:workWaits`), so a page or the
 * steward saying an item waits on the Master and the box saying `nothing_owed` cannot both stand.
 *
 * A wait naming the master is left out only where its act is counted elsewhere or is not owed yet,
 * each said in {@link LEFT_OUT}.
 */

import type { ItemStanding, StandingSubject } from '@forge/contracts/steward';
import { actChain, innermostAct, waitNamesMaster } from '../lib/master-wait.js';
import { openStandings } from './read.js';

export interface StandingActOwed {
  subject: StandingSubject;
  /** The said key of the act its wait names, read through what wraps it: the act's identity. */
  key: string;
  /** The act as the item's page says it to the master, in English. */
  act: string;
}

/**
 * The acts naming the master that this read does not count, and why. Any act in a wait's chain
 * leaves the wait out, so a requirement's or feedback item's roll-up of an issue's act is left out
 * with the issue's own act.
 */
const LEFT_OUT: Readonly<Record<string, string>> = {
  // claimable: the box's admissible read (`devices/admissible.ts`) counts each for the box whose
  // fence admits it, so a box fenced from the issue is never placed for it
  'issues.standing.act.dispatch': 'claimable issue, counted as admissible',
  'issues.standing.act.buildNext': 'claimable issue, counted as admissible',
  'issues.standing.act.rerun': 'claimable issue, counted as admissible',
  // a draft issue: a person's is the requests read's where the gate is off, a triage's the carriers
  // read's, and an agent's is its own work in progress (REQ-76 BC-9, ISS-840)
  'issues.standing.act.takeOnOrDrop': 'a draft issue, counted by the requests and carriers reads',
  // a requirement's or feedback item's wait on its issue: that issue's own standing, in this read
  'standing.act.onIssue': "the issue's own act, counted once on the issue",
  // a feedback item's draft carrier: the carrier issue's own act, which the carriers read names (ISS-840)
  'standing.act.takeOn': "the draft carrier's own act, counted once on the carrier",
  // the carrier issue waits on a person's answer or act first; its own standing names the master
  // once that comes, and is counted then
  'standing.act.moveOnAnswered': 'waits on an answer first',
  'standing.act.moveOn': 'waits on a person first',
  // owed from its date: `feedback/owed-triage.ts:owedTriages` counts it once the snooze ends
  'feedback.act.triageAfterSnooze': 'snoozed until its date',
};

function counted(item: ItemStanding): boolean {
  const w = item.waitingOn;
  return waitNamesMaster(w) && !actChain(w.says.act).some((a) => Object.hasOwn(LEFT_OUT, a.key));
}

/** Every open item whose standing waits on the master, with the act it names, as the standing read orders them. */
export async function standingActsOwed(projectId: string): Promise<StandingActOwed[]> {
  return (await openStandings(projectId)).filter(counted).map((i) => ({
    subject: i.subject,
    key: innermostAct(i.waitingOn.says.act).key,
    act: i.waitingOn.act,
  }));
}
