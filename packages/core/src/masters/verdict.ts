import {
  MASTER_IDLE_BEFORE_RETIRE_SECONDS,
  MASTER_NUDGE_REFRESH_SECONDS,
  type MasterFacts,
  type MasterSinceNudge,
  type MasterVerdict,
} from '@forge/contracts/master-verdict';
import { subagentOver } from '../devices/index.js';

/** What core contributes beside the box's facts: its runner row's status and its master's pass record. */
export interface MasterRecord {
  runnerStatus: string;
  passOpen: boolean;
}

const minutes = (seconds: number) => Math.floor(seconds / 60);

function runnerAccepts(status: string): boolean {
  return status !== 'draining' && status !== 'disabled';
}

/** Whether the project has anything a master would be placed for: issues, owed items or a waiting pool job. */
function workWaits(facts: MasterFacts): boolean {
  const { admissible, owed, poolWaits } = facts.work;
  return admissible > 0 || owed > 0 || poolWaits;
}

/**
 * Whether the pane sits behind its account's capacity refusal: the newest thing its conversation
 * says is a quota refusal, and its hooks contradict neither half of that reading — they name no
 * other conversation, and report no turn begun after the refusal. Age does not end it: a refusal
 * with nothing after it is the last thing the pane's account said to it (ISS-1248).
 */
export function limitHeld(limit: MasterFacts['limit']): boolean {
  const { refusal, hooks, turnStartedAgoMs } = limit;
  if (refusal === null || refusal.reason === 'auth' || hooks === 'other') return false;
  return turnStartedAgoMs === null || turnStartedAgoMs >= refusal.agoMs;
}

/** Whether a master pass is owed at all: a pool job is taken under the master, not passed to it. */
function passAsked(facts: MasterFacts): boolean {
  return facts.work.admissible > 0 || facts.work.owed > 0 || limitHeld(facts.limit);
}

function withheld(facts: MasterFacts, record: MasterRecord): MasterVerdict | null {
  if (facts.standing === 'unreadable') {
    return {
      act: 'withhold',
      reason: 'standing_unreadable',
      because:
        'the box cannot read whether its owner stood this project down, and a box that cannot tell a stood-down project from a driving one must not decide it is driving',
    };
  }
  if (facts.standing === 'stood_down' && facts.pane === 'alive') {
    return {
      act: 'leave',
      reason: 'stood_down',
      because:
        'its owner stood this master down and a pane is up anyway; it is neither driven nor ended, since the box ends no pane its owner did not ask it to',
    };
  }
  if (facts.restarting !== null) {
    return {
      act: 'withhold',
      reason: 'restarting',
      because: `the box is handing over to a new build (${facts.restarting}) and admits no new work`,
    };
  }
  if (!runnerAccepts(record.runnerStatus)) {
    return {
      act: 'withhold',
      reason: 'runner_not_accepting',
      because: `this box's runner for the project is ${record.runnerStatus}, so it takes no new work and places no master`,
    };
  }
  if (facts.standing === 'stood_down') {
    return {
      act: 'withhold',
      reason: 'stood_down',
      because: 'its owner stood this master down; none is placed until it is stood up',
    };
  }
  if (!facts.terminal) {
    return {
      act: 'withhold',
      reason: 'no_terminal',
      because: 'the box has no terminal multiplexer, so it can host no master pane',
    };
  }
  return null;
}

/** Why a master that has had no work for the idle window still stays, or null where it may be retired. */
export function idleStay(facts: MasterFacts): string | null {
  const { noWorkForSeconds, pane, children } = facts.idle;
  const window = MASTER_IDLE_BEFORE_RETIRE_SECONDS;
  if (noWorkForSeconds === null || noWorkForSeconds < window) {
    return 'there was work inside the idle window';
  }
  if (children.unfinished.length > 0) {
    return `child runs whose close has not finished: ${children.unfinished.join(', ')}`;
  }
  if (!pane) return 'the box has heard no hook from its pane, so whether a turn runs is not known';
  if (pane.doing !== 'idle') return `its pane is ${pane.doing}`;
  if (pane.lastEventAgoSeconds < window) {
    return `its pane reported \`${pane.lastEvent}\` ${minutes(pane.lastEventAgoSeconds)}m ago`;
  }
  if (children.lastClosedAgoSeconds !== null && children.lastClosedAgoSeconds < window) {
    return `a child run closed ${minutes(children.lastClosedAgoSeconds)}m ago`;
  }
  return null;
}

function retireBecause(facts: MasterFacts): string {
  const { noWorkForSeconds, pane, children } = facts.idle;
  const declared =
    children.total === 0
      ? 'it declared no child run'
      : `all ${children.total} child run(s) it declared are closed${
          children.lastClosedAgoSeconds === null
            ? ''
            : `, the last ${minutes(children.lastClosedAgoSeconds)}m ago`
        }`;
  return `idle: its pane's last hook was \`${pane?.lastEvent}\` ${minutes(
    pane?.lastEventAgoSeconds ?? 0,
  )}m ago with no turn running, nothing was claimable for ${minutes(
    noWorkForSeconds ?? 0,
  )}m, and ${declared}`;
}

/** Why the successor of a replaced pane could not resume its conversation, or null where it could. */
function unresumable(facts: MasterFacts): string | null {
  const { id, transcript } = facts.conversation;
  if (id === null) {
    return 'the box has recorded no conversation for it, so a successor would start cold, without what it was doing';
  }
  if (transcript === 'absent') {
    return `its conversation ${id} has no transcript on the box, so a successor would start cold, without what it was doing`;
  }
  if (transcript === 'unlocatable') {
    return `the box has no home directory to find conversation ${id}'s transcript under, so a successor could not be shown to resume it`;
  }
  return null;
}

/**
 * What an outdated pane's replacement waits on: every reason that holds against it, named, and
 * whether it drains. A pane drains, taking no new run, wherever its successor could resume its
 * conversation, so that what it holds runs out and the replacement is reached; a pane whose
 * successor would start cold is not drained, since nothing would be placed in its stead.
 */
export interface OutdatedHold {
  why: string;
  heldBy: string[];
  drain: boolean;
}

/** The runs a pane holds, split by whether core reads each one's subagent as over, and why. */
function heldRuns(holding: MasterFacts['holding']): { working: string[]; over: string[] } {
  const working: string[] = [];
  const over: string[] = [];
  if (holding.kind !== 'these') return { working, over };
  for (const run of holding.runs) {
    const ended = subagentOver(run.subagent);
    if (ended === null) working.push(run.name);
    else over.push(`${run.name} — ${ended}`);
  }
  return { working, over };
}

/** Null where the pane is current, unjudged or absent. */
export function outdatedHold(facts: MasterFacts): OutdatedHold | null {
  if (facts.pane !== 'alive' || facts.outdated === null) return null;
  const heldBy: string[] = [];
  if (!workWaits(facts)) {
    heldBy.push('its project has no admissible work, so a successor would have nothing to take up');
  }
  const { holding, turn } = facts;
  const { working } = heldRuns(holding);
  if (working.length > 0) {
    heldBy.push(
      `it holds ${working.length} open run(s) whose subagent may still be working: ${working.join('; ')}`,
    );
  }
  if (holding.kind === 'unknown') heldBy.push(holding.why);
  if (turn.kind === 'in_turn') heldBy.push(turn.what);
  if (turn.kind === 'unknown') {
    heldBy.push('neither its hooks nor its transcript can say whether its turn is over');
  }
  const cold = unresumable(facts);
  if (cold) heldBy.push(cold);
  return { why: facts.outdated, heldBy, drain: cold === null };
}

/** An outdated pane nothing holds is replaced, resuming its conversation; null where something holds it. */
function outdatedReplace(facts: MasterFacts, hold: OutdatedHold): MasterVerdict | null {
  if (hold.heldBy.length > 0) return null;
  const inherited = heldRuns(facts.holding).over;
  return {
    act: 'replace',
    reason: 'outdated',
    resume: facts.conversation.id,
    nudge: passAsked(facts),
    because: `outdated (${hold.why}) and ${
      inherited.length === 0
        ? 'holds no run and no turn'
        : `holds no turn and no run still working; its successor inherits ${inherited.join('; ')}`
    }`,
  };
}

/**
 * A kept pane's account of being outdated: why, what its replacement waits on, and whether it
 * drains. Being outdated decides replacement only, so the pane is nudged on a current master's timing.
 */
function outdatedKept(hold: OutdatedHold): string {
  return `outdated (${hold.why}), and its replacement waits: ${hold.heldBy.join('; ')}. ${
    hold.drain
      ? 'It drains meanwhile: it is driven for the work it is owed and takes no new run, so what it holds runs out'
      : 'It is not drained, since its successor would start cold and nothing would be placed in its stead'
  }`;
}

/** A pane the box cannot hear is ended only where a successor would be placed in its stead. */
export function deafVerdict(facts: MasterFacts): MasterVerdict {
  const left = !workWaits(facts)
    ? 'this project has no admissible work, so no replacement would be placed in its stead'
    : facts.serversReadable !== true
      ? "the box could not read the project's declared MCP servers, so no replacement would be placed in its stead"
      : facts.conversation.elsewhere !== 'none'
        ? 'its conversation may still run as a background session on the box, so a replacement would exit at once'
        : null;
  if (left)
    return { act: 'leave', reason: 'deaf', because: `its pane cannot be heard and ${left}` };
  return {
    act: 'replace',
    reason: 'deaf',
    resume: resumeOf(facts),
    nudge: passAsked(facts),
    because:
      'its pane holds a capability for a session core has since replaced, so every declaration it makes is refused',
  };
}

function retryOwed(since: MasterSinceNudge): boolean {
  return since === 'unreported' || since === 'no_turn' || since === 'failed';
}

/**
 * Whether the master is owed a nudge now. A changed digest waits for the open pass to close; a
 * limited master is asked again every refresh window whatever its pane says; the same work is asked
 * again only once the window has passed and the last nudge started no turn or ended in a failure.
 */
export function nudgeDue(facts: MasterFacts, passOpen: boolean): { due: boolean; because: string } {
  const { last, digest, since } = facts.nudge;
  const windowPassed = last !== null && last.agoSeconds >= MASTER_NUDGE_REFRESH_SECONDS;
  if (!passAsked(facts)) return { due: false, because: 'nothing is owed a pass' };
  if (last === null) return { due: true, because: 'it has not been nudged about this work' };
  if (limitHeld(facts.limit)) {
    return windowPassed
      ? { due: true, because: 'it sits behind its account limit and the refresh window has passed' }
      : { due: false, because: 'it sits behind its account limit and was asked inside the window' };
  }
  if (last.digest !== digest) {
    return passOpen
      ? { due: false, because: 'the work changed and its pass is still open' }
      : { due: true, because: 'the work changed since its last nudge' };
  }
  if (windowPassed && retryOwed(since)) {
    return { due: true, because: `its last nudge read ${since} and the refresh window has passed` };
  }
  return { due: false, because: `its last nudge read ${since}` };
}

function resumeOf(facts: MasterFacts): string | null {
  return facts.conversation.transcript === 'present' ? facts.conversation.id : null;
}

function placeVerdict(facts: MasterFacts): MasterVerdict {
  if (!workWaits(facts)) {
    return {
      act: 'withhold',
      reason: 'nothing_owed',
      because: 'it has nothing claimable and no pane of its own running',
    };
  }
  if (facts.conversation.elsewhere === 'running') {
    return {
      act: 'withhold',
      reason: 'conversation_elsewhere',
      because:
        'its last pane exited because a process on the box still runs its conversation as a background session; a pane placed again would exit the same way',
    };
  }
  if (facts.conversation.elsewhere === 'unreadable') {
    return {
      act: 'withhold',
      reason: 'conversation_unaskable',
      because:
        'its last pane exited over a background session and the box cannot read its process table to tell whether one still runs it',
    };
  }
  const resume = resumeOf(facts);
  return {
    act: 'place',
    resume,
    nudge: passAsked(facts),
    because:
      resume !== null
        ? `work waits; resuming conversation ${resume}`
        : facts.conversation.id === null
          ? 'work waits; starting cold, as no conversation is recorded for it'
          : `work waits; starting cold, as conversation ${facts.conversation.id} has no transcript on the box`,
  };
}

/**
 * The whole of the placement and retirement decision for one project's master on one box. An
 * outdated pane that may be replaced is; a deaf one is judged next, since a pane nobody can hear
 * holds nothing an outdated pane is kept for; any other pane is kept and driven, an outdated one
 * draining toward its replacement.
 */
export function masterVerdict(facts: MasterFacts, record: MasterRecord): MasterVerdict {
  const held = withheld(facts, record);
  if (held) return held;
  if (facts.pane === 'absent') return placeVerdict(facts);
  if (!workWaits(facts) && facts.work.jobPanes === 0 && idleStay(facts) === null) {
    return { act: 'retire', because: retireBecause(facts) };
  }
  const outdated = outdatedHold(facts);
  const replace = outdated ? outdatedReplace(facts, outdated) : null;
  if (replace) return replace;
  if (facts.capability === 'stale') return deafVerdict(facts);
  const nudge = nudgeDue(facts, record.passOpen);
  if (!outdated) return { act: 'keep', nudge: nudge.due, drain: false, because: nudge.because };
  return {
    act: 'keep',
    nudge: nudge.due,
    drain: outdated.drain,
    because: `${outdatedKept(outdated)}; nudge: ${nudge.because}`,
  };
}
