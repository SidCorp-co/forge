/**
 * The acts the project's open issues, requirements, feedback items and workflows wait on its master
 * for (ISS-1278): the one standing read (`read.ts:openStandings`), each wait passing the one test of
 * naming the master (`lib/master-wait.ts:waitNamesMaster`) that the releases' read applies too.
 * Placement and retirement count each as owed work (`masters/verdict.ts:workWaits`), so a page or the
 * steward saying an item waits on the Master and the box saying `nothing_owed` cannot both stand,
 * unless the master recorded why it waits.
 *
 * A wait naming the master is left out only where its act is counted elsewhere or is not owed yet,
 * each said in {@link LEFT_OUT}, or where the master already recorded why it waits (ISS-1282): a
 * decision on the item, at its own kind's door (`masters/decision-doors.ts`), holding it by a date
 * to come or a condition, read as a requirement's standing reads one ({@link heldIds}). The same
 * reading holds a claimable issue off the master's admissible line (ISS-1297).
 */

import type { ItemStanding, StandingSubject } from '@forge/contracts/steward';
import { reasonedDecisionsOnItems } from '../comments/index.js';
import { reasonedDecisionsOn } from '../issues/index.js';
import { actChain, innermostAct, waitNamesMaster } from '../lib/master-wait.js';
import { heldByDecision } from '../requirements/index.js';
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
  // a feedback item's wait on the release run carrying its carriers: the release's own act, which
  // the releases' read counts (`release-batch/master-owed-acts.ts`, ISS-1295)
  'standing.act.onRelease': "the release's own act, counted once on the release",
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

/** The rule a requirement's standing names where a decision on it holds its wait (`requirements/standing-held.ts:heldRule`). */
const HELD_RULE = 'requirements.rule.heldByDecision';

type Decided = Parameters<typeof heldByDecision>[0] & { subjectId: string };

/** The newest reasoned decision on each of these items of one kind, by the item's id. */
async function newestDecisions(
  kind: 'issue' | 'feedback' | 'workflow',
  ids: readonly string[],
): Promise<Map<string, Decided>> {
  const all: Decided[] =
    kind === 'issue'
      ? (await reasonedDecisionsOn(ids)).map((d) => ({ ...d, subjectId: d.issueId }))
      : await reasonedDecisionsOnItems(kind, ids);
  const newest = new Map<string, Decided>();
  for (const d of all) if (!newest.has(d.subjectId)) newest.set(d.subjectId, d);
  return newest;
}

/**
 * The items a decision holds: a requirement's standing already names the hold in its rule; an
 * issue's, feedback item's or workflow's newest decision is read by the same rule against when its
 * wait began, so one recorded after it with a date to come or a condition holds it.
 */
async function heldIds(items: readonly ItemStanding[], now: Date): Promise<Set<string>> {
  const held = new Set(
    items.filter((i) => i.waitingOn.says.rule.key === HELD_RULE).map((i) => i.subject.id),
  );
  for (const kind of ['issue', 'feedback', 'workflow'] as const) {
    const ofKind = items.filter((i) => i.subject.kind === kind);
    const newest = await newestDecisions(
      kind,
      ofKind.map((i) => i.subject.id),
    );
    for (const i of ofKind) {
      const d = newest.get(i.subject.id) ?? null;
      if (heldByDecision(d, new Date(i.since), now)) held.add(i.subject.id);
    }
  }
  return held;
}

/** What the master's standings owe: the acts this read counts, and the issues a decision holds. */
export interface MasterStandingsOwed {
  acts: StandingActOwed[];
  /**
   * The issues whose wait on the master a decision of its holds, a claimable one's included (ISS-1297):
   * the admissible line withholds each as the standings line withholds a held item, so one passed over
   * until a date or while a condition holds is listed again once the date passes or its wait moves.
   */
  heldIssues: ReadonlySet<string>;
}

/** Every open item whose standing waits on the master, with the act it names, as the standing read orders them. */
export async function masterStandingsOwed(projectId: string): Promise<MasterStandingsOwed> {
  const waits = (await openStandings(projectId)).filter((i) => waitNamesMaster(i.waitingOn));
  const held = await heldIds(waits, new Date());
  const acts = waits
    .filter((i) => counted(i) && !held.has(i.subject.id))
    .map((i) => ({
      subject: i.subject,
      key: innermostAct(i.waitingOn.says.act).key,
      act: i.waitingOn.act,
    }));
  const heldIssues = new Set(
    waits
      .filter((i) => i.subject.kind === 'issue' && held.has(i.subject.id))
      .map((i) => i.subject.id),
  );
  return { acts, heldIssues };
}
