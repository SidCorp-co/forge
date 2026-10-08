import {
  MASTER_IDLE_BEFORE_RETIRE_SECONDS,
  MASTER_NUDGE_REFRESH_SECONDS,
  type MasterFacts,
  type MasterSinceNudge,
  type MasterVerdict,
} from '@forge/contracts/master-verdict';
import { type Said, say, sayEn, verbatim } from '@forge/contracts/said';
import { subagentOver } from '../devices/index.js';

/**
 * The box's facts with the work core read beside them: the admissible and owed counts in `work`,
 * and the digest of that work in `nudge`, so every rule below reads one document.
 */
export type MasterJudged = Omit<MasterFacts, 'work' | 'nudge'> & {
  work: MasterFacts['work'] & { admissible: number; owed: number };
  nudge: MasterFacts['nudge'] & { digest: string };
};

/** The box's facts joined to the work core read for the project. */
export function judged(
  facts: MasterFacts,
  work: { admissible: number; owed: number; digest: string },
): MasterJudged {
  return {
    ...facts,
    work: { ...facts.work, admissible: work.admissible, owed: work.owed },
    nudge: { ...facts.nudge, digest: work.digest },
  };
}

/** What core contributes beside the box's facts: its runner row's status and its master's pass record. */
export interface MasterRecord {
  runnerStatus: string;
  passOpen: boolean;
}

const minutes = (seconds: number) => Math.floor(seconds / 60);

/** A verdict's reason: its English for the box beside the sentence it was rendered from. */
const because = (s: Said) => ({ because: sayEn(s), says: { because: s } });

function runnerAccepts(status: string): boolean {
  return status !== 'draining' && status !== 'disabled';
}

/** Whether the project has anything a master would be placed for: issues, owed items or a waiting pool job. */
function workWaits(facts: MasterJudged): boolean {
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
function passAsked(facts: MasterJudged): boolean {
  return facts.work.admissible > 0 || facts.work.owed > 0 || limitHeld(facts.limit);
}

function withheld(facts: MasterJudged, record: MasterRecord): MasterVerdict | null {
  if (facts.standing === 'unreadable') {
    return {
      act: 'withhold',
      reason: 'standing_unreadable',
      ...because(say('masters.verdict.standingUnreadable')),
    };
  }
  if (facts.standing === 'stood_down' && facts.pane === 'alive') {
    return {
      act: 'leave',
      reason: 'stood_down',
      ...because(say('masters.verdict.stoodDownAlive')),
    };
  }
  if (facts.restarting !== null) {
    return {
      act: 'withhold',
      reason: 'restarting',
      ...because(say('masters.verdict.restarting', { cause: facts.restarting })),
    };
  }
  if (!runnerAccepts(record.runnerStatus)) {
    return {
      act: 'withhold',
      reason: 'runner_not_accepting',
      ...because(say('masters.verdict.runnerNotAccepting', { status: record.runnerStatus })),
    };
  }
  if (facts.standing === 'stood_down') {
    return {
      act: 'withhold',
      reason: 'stood_down',
      ...because(say('masters.verdict.stoodDown')),
    };
  }
  if (!facts.terminal) {
    return {
      act: 'withhold',
      reason: 'no_terminal',
      ...because(say('masters.verdict.noTerminal')),
    };
  }
  return null;
}

/** Why a master that has had no work for the idle window still stays, or null where it may be retired. */
export function idleStay(facts: MasterJudged): Said | null {
  const { noWorkForSeconds, pane, children } = facts.idle;
  const window = MASTER_IDLE_BEFORE_RETIRE_SECONDS;
  if (noWorkForSeconds === null || noWorkForSeconds < window) {
    return say('masters.verdict.idleWindowWork');
  }
  if (children.unfinished.length > 0) {
    return say('masters.verdict.childrenUnfinished', { names: children.unfinished.join(', ') });
  }
  if (!pane) return say('masters.verdict.paneUnheard');
  if (pane.doing !== 'idle') return say('masters.verdict.paneDoing', { doing: pane.doing });
  if (pane.lastEventAgoSeconds < window) {
    return say('masters.verdict.paneReported', {
      event: pane.lastEvent,
      m: minutes(pane.lastEventAgoSeconds),
    });
  }
  if (children.lastClosedAgoSeconds !== null && children.lastClosedAgoSeconds < window) {
    return say('masters.verdict.childClosed', { m: minutes(children.lastClosedAgoSeconds) });
  }
  return null;
}

function retireBecause(facts: MasterJudged): Said {
  const { noWorkForSeconds, pane, children } = facts.idle;
  const declared =
    children.total === 0
      ? say('masters.verdict.noChildDeclared')
      : say('masters.verdict.childrenClosed', {
          n: children.total,
          last:
            children.lastClosedAgoSeconds === null
              ? null
              : say('masters.verdict.lastClosedAgo', { m: minutes(children.lastClosedAgoSeconds) }),
        });
  return say('masters.verdict.retire', {
    event: String(pane?.lastEvent),
    m: minutes(pane?.lastEventAgoSeconds ?? 0),
    idle: minutes(noWorkForSeconds ?? 0),
    declared,
  });
}

/** Why the successor of a replaced pane could not resume its conversation, or null where it could. */
function unresumable(facts: MasterJudged): Said | null {
  const { id, transcript } = facts.conversation;
  if (id === null) {
    return say('masters.verdict.noConversation');
  }
  if (transcript === 'absent') {
    return say('masters.verdict.noTranscript', { id });
  }
  if (transcript === 'unlocatable') {
    return say('masters.verdict.noHome', { id });
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
  why: Said;
  heldBy: Said[];
  drain: boolean;
}

/** The runs a pane holds, split by whether core reads each one's subagent as over, and why. */
function heldRuns(holding: MasterFacts['holding']): { working: string[]; over: Said[] } {
  const working: string[] = [];
  const over: Said[] = [];
  if (holding.kind !== 'these') return { working, over };
  for (const run of holding.runs) {
    const ended = subagentOver(run.subagent);
    if (ended === null) working.push(run.name);
    else over.push(say('masters.verdict.inherited', { name: run.name, ended }));
  }
  return { working, over };
}

/**
 * Why the pane is outdated, or null where it is current: outdated only where an input it was
 * placed with differs from what the box would hand a pane now, each named — a rebuild of the runner
 * that changes none of them leaves it current. An input one side could not read is no evidence of a
 * change. A pane with no record of what it was placed with, or one the box cannot read, is outdated
 * by name: it was placed by a build older than any that records one, or adopted by a box that never
 * placed it, and what it runs on is not known.
 */
export function outdatedWhy(facts: Pick<MasterFacts, 'placement'>): Said | null {
  const placement = facts.placement;
  if (!placement) return null;
  if (placement.unreadable !== null) {
    return say('masters.verdict.placementUnreadable', { why: placement.unreadable });
  }
  const { placed, now } = placement;
  if (placed === null) {
    return say('masters.verdict.placementUnrecorded');
  }
  const changed = Object.keys(placed)
    .filter((name) => now[name] !== undefined && now[name] !== placed[name])
    .sort()
    .map((name) =>
      say('masters.verdict.inputChanged', {
        name,
        placed: String(placed[name]),
        now: String(now[name]),
      }),
    );
  return changed.length === 0 ? null : say('masters.verdict.inputsChanged', { changed });
}

/** Null where the pane is current, unjudged or absent. */
export function outdatedHold(facts: MasterJudged): OutdatedHold | null {
  const why = outdatedWhy(facts);
  if (facts.pane !== 'alive' || why === null) return null;
  const heldBy: Said[] = [];
  if (!workWaits(facts)) heldBy.push(say('masters.verdict.heldNoWork'));
  const { holding, turn } = facts;
  const { working } = heldRuns(holding);
  if (working.length > 0) {
    heldBy.push(say('masters.verdict.heldRuns', { n: working.length, names: working.join('; ') }));
  }
  if (holding.kind === 'unknown') heldBy.push(verbatim(holding.why));
  if (turn.kind === 'in_turn') heldBy.push(verbatim(turn.what));
  if (turn.kind === 'unknown') heldBy.push(say('masters.verdict.heldTurnUnknown'));
  const cold = unresumable(facts);
  if (cold) heldBy.push(cold);
  return { why, heldBy, drain: cold === null };
}

/** An outdated pane nothing holds is replaced, resuming its conversation; null where something holds it. */
function outdatedReplace(facts: MasterJudged, hold: OutdatedHold): MasterVerdict | null {
  if (hold.heldBy.length > 0) return null;
  const inherited = heldRuns(facts.holding).over;
  return {
    act: 'replace',
    reason: 'outdated',
    resume: facts.conversation.id,
    nudge: passAsked(facts),
    ...because(
      inherited.length === 0
        ? say('masters.verdict.replaceIdle', { why: hold.why })
        : say('masters.verdict.replaceInherits', { why: hold.why, runs: inherited }),
    ),
  };
}

/**
 * A kept pane's account of being outdated: why, what its replacement waits on, and whether it
 * drains. Being outdated decides replacement only, so the pane is nudged on a current master's timing.
 */
function outdatedKept(hold: OutdatedHold): Said {
  return say(hold.drain ? 'masters.verdict.keptDrains' : 'masters.verdict.keptCold', {
    why: hold.why,
    held: hold.heldBy,
  });
}

/** A pane the box cannot hear is ended only where a successor would be placed in its stead. */
export function deafVerdict(facts: MasterJudged): MasterVerdict {
  const left = !workWaits(facts)
    ? say('masters.verdict.deafNoWork')
    : facts.serversReadable !== true
      ? say('masters.verdict.deafNoServers')
      : facts.conversation.elsewhere !== 'none'
        ? say('masters.verdict.deafElsewhere')
        : null;
  if (left) {
    return {
      act: 'leave',
      reason: 'deaf',
      ...because(say('masters.verdict.deafLeave', { left })),
    };
  }
  return {
    act: 'replace',
    reason: 'deaf',
    resume: resumeOf(facts),
    nudge: passAsked(facts),
    ...because(say('masters.verdict.deafReplace')),
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
export function nudgeDue(facts: MasterJudged, passOpen: boolean): { due: boolean; because: Said } {
  const { last, digest, since } = facts.nudge;
  const windowPassed = last !== null && last.agoSeconds >= MASTER_NUDGE_REFRESH_SECONDS;
  const due = (d: boolean, s: Said) => ({ due: d, because: s });
  if (!passAsked(facts)) return due(false, say('masters.verdict.nudgeNothingOwed'));
  if (last === null) return due(true, say('masters.verdict.nudgeNever'));
  if (limitHeld(facts.limit)) {
    return windowPassed
      ? due(true, say('masters.verdict.nudgeLimitPassed'))
      : due(false, say('masters.verdict.nudgeLimitInside'));
  }
  if (last.digest !== digest) {
    return passOpen
      ? due(false, say('masters.verdict.nudgeChangedOpen'))
      : due(true, say('masters.verdict.nudgeChanged'));
  }
  if (windowPassed && retryOwed(since)) {
    return due(true, say('masters.verdict.nudgeRetry', { since }));
  }
  return due(false, say('masters.verdict.nudgeRead', { since }));
}

function resumeOf(facts: MasterJudged): string | null {
  return facts.conversation.transcript === 'present' ? facts.conversation.id : null;
}

function placeVerdict(facts: MasterJudged): MasterVerdict {
  if (!workWaits(facts)) {
    return {
      act: 'withhold',
      reason: 'nothing_owed',
      ...because(say('masters.verdict.nothingClaimable')),
    };
  }
  if (facts.conversation.elsewhere === 'running') {
    return {
      act: 'withhold',
      reason: 'conversation_elsewhere',
      ...because(say('masters.verdict.conversationElsewhere')),
    };
  }
  if (facts.conversation.elsewhere === 'unreadable') {
    return {
      act: 'withhold',
      reason: 'conversation_unaskable',
      ...because(say('masters.verdict.conversationUnaskable')),
    };
  }
  const resume = resumeOf(facts);
  return {
    act: 'place',
    resume,
    nudge: passAsked(facts),
    ...because(
      resume !== null
        ? say('masters.verdict.placeResume', { id: resume })
        : facts.conversation.id === null
          ? say('masters.verdict.placeColdNone')
          : say('masters.verdict.placeColdNoTranscript', { id: facts.conversation.id }),
    ),
  };
}

/**
 * The whole of the placement and retirement decision for one project's master on one box. An
 * outdated pane that may be replaced is; a deaf one is judged next, since a pane nobody can hear
 * holds nothing an outdated pane is kept for; any other pane is kept and driven, an outdated one
 * draining toward its replacement.
 */
export function masterVerdict(facts: MasterJudged, record: MasterRecord): MasterVerdict {
  const held = withheld(facts, record);
  if (held) return held;
  if (facts.pane === 'absent') return placeVerdict(facts);
  if (!workWaits(facts) && facts.work.jobPanes === 0 && idleStay(facts) === null) {
    return { act: 'retire', ...because(retireBecause(facts)) };
  }
  const outdated = outdatedHold(facts);
  const replace = outdated ? outdatedReplace(facts, outdated) : null;
  if (replace) return replace;
  if (facts.capability === 'stale') return deafVerdict(facts);
  const nudge = nudgeDue(facts, record.passOpen);
  if (!outdated) return { act: 'keep', nudge: nudge.due, drain: false, ...because(nudge.because) };
  return {
    act: 'keep',
    nudge: nudge.due,
    drain: outdated.drain,
    ...because(
      say('masters.verdict.keptNudge', { kept: outdatedKept(outdated), nudge: nudge.because }),
    ),
  };
}
