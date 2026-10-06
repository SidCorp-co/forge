import {
  RUN_IDLE_BEFORE_EXIT_MS,
  RUN_SILENT_BEFORE_EXIT_MS,
  RUN_UNANSWERED_RELEASE_AFTER_MS,
  RUN_UNBOUND_BEFORE_END_MS,
  type RunExitCause,
  type RunFacts,
  type RunHostEnd,
  type RunStanding,
  type RunSubagent,
  type RunVerdict,
} from '@forge/contracts/run-verdict';

/**
 * What core reads beside the box's facts: whether each issue the run holds is over, and whether
 * it rests (over, or parked at `needs_info` or `on_hold`). `null` is *not known*, which never
 * licenses an end: a guess there closes a run somebody is using (ISS-1245).
 */
export interface RunIssues {
  over: ReadonlyArray<boolean | null>;
  rests: ReadonlyArray<boolean | null>;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

type Presence = RunFacts['master'];

/**
 * The master a run answers to, as the run's own evidence lets it be read. A read tmux could not
 * answer observed nothing, so it decides as under the pane last seen. An open subagent's master
 * is the process it runs in: read alive, it is a background session outside its pane; with that
 * process not read gone, a pane read gone licenses nothing a master the box has no entry for
 * would not (ISS-1312).
 */
function effectiveMaster(f: RunFacts): Presence {
  const openSubagent = f.process === 'none' && !f.ended;
  if (f.master === 'unanswered') return 'alive';
  if (!openSubagent) return f.master;
  if ((f.master === 'gone' || f.master === 'unknown') && f.host === 'alive') return 'alive';
  if (f.master === 'gone') return f.host === 'gone' ? 'gone' : 'unknown';
  return f.master;
}

function hostEnd(f: RunFacts): RunHostEnd | null {
  return f.process === 'none' ? f.hostEnded : null;
}

function every(values: ReadonlyArray<boolean | null>): boolean {
  return values.length > 0 && values.every((v) => v === true);
}

function unboundEnd(f: RunFacts): string | null {
  const unbound =
    !f.bound &&
    f.process === 'none' &&
    !f.ended &&
    f.thisBoot &&
    f.declaredAgoMs >= RUN_UNBOUND_BEFORE_END_MS;
  if (!unbound) return null;
  return `declared ${minutes(f.declaredAgoMs)}m ago and never bound to a subagent or a process, past the ${minutes(RUN_UNBOUND_BEFORE_END_MS)}m within which a declared run binds, so core ended it; its session and its leases go back by the close loop, and its issues can be declared again`;
}

function staleEnd(f: RunFacts, issues: RunIssues): string | null {
  const stale =
    f.process === 'none' &&
    !f.ended &&
    f.thisBoot &&
    f.checkoutGone === true &&
    issues.rests.length === f.issueKeys.length &&
    every(issues.rests);
  if (!stale) return null;
  return `stale declaration: ${f.issueKeys.join(', ')} rest at core (over, or parked at needs_info or on_hold) and its checkout is gone, so no subagent works it`;
}

/**
 * Whether a run's agent is over while it still runs. A run is briefed once, so an ended turn is
 * evidence of done; a turn or a lead whose end never arrived is judged by its transcript's
 * silence, and no transcript to read is no evidence and never silence.
 */
export function exitCause(activity: RunFacts['activity']): RunExitCause | null {
  if (!activity) return null;
  const silentFor =
    activity.writtenAgoMs === null
      ? activity.lastEventAgoMs
      : Math.min(activity.writtenAgoMs, activity.lastEventAgoMs);
  switch (activity.doing) {
    case 'working':
      return activity.writtenAgoMs !== null && silentFor >= RUN_SILENT_BEFORE_EXIT_MS
        ? 'lead_silent'
        : null;
    case 'awaiting_children':
      return silentFor >= RUN_SILENT_BEFORE_EXIT_MS ? 'children_silent' : null;
    case 'idle':
      return activity.lastEventAgoMs >= RUN_IDLE_BEFORE_EXIT_MS ? 'idle' : null;
    case 'awaiting_permission':
      return null;
  }
}

/**
 * Why a subagent is over, or null while it may still be working: the process it ran in is gone, or
 * it ended a turn, or was handed an entry, and nothing followed for the silence a run is allowed.
 * It may still be resumed, so this ends nothing by itself: it is what a master's successor inherits,
 * and what the box says once about a run it keeps.
 */
export function subagentOver(subagent: RunSubagent): string | null {
  const silent = subagent.silentMs ?? 0;
  switch (subagent.kind) {
    case 'host_ended':
      return `the Claude Code process its subagent ran in was read gone ${minutes(silent)}m ago, and nothing has been heard from its subagent since`;
    case 'turn_ended':
      return silent >= RUN_SILENT_BEFORE_EXIT_MS
        ? `its subagent ended a turn ${minutes(silent)}m ago and wrote nothing after it`
        : null;
    case 'awaiting_reply':
      return silent >= RUN_SILENT_BEFORE_EXIT_MS
        ? `its subagent ended a turn, and the entry handed to it after that, written ${minutes(silent)}m ago, has had no reply`
        : null;
    default:
      return null;
  }
}

/** Whether the box owes a line on why it keeps a subagent: it reads over, or its transcript cannot say. */
function keptSaid(subagent: RunSubagent): boolean {
  return (
    subagentOver(subagent) !== null ||
    subagent.kind === 'unreadable' ||
    subagent.kind === 'tail_unreadable'
  );
}

const EXIT_BECAUSE: Record<RunExitCause, string> = {
  idle: `its agent ended its turn and reported nothing for ${minutes(RUN_IDLE_BEFORE_EXIT_MS)}m after — a run is briefed once, so its work is done; core ended it`,
  children_silent: `its agent ended its turn over a child that never reported an end, and nothing was reported or written for ${minutes(RUN_SILENT_BEFORE_EXIT_MS)}m — a child's end reaches the box by a hook that can be lost; core ended it`,
  lead_silent: `its agent's turn never reported an end and its transcript was written nothing for ${minutes(RUN_SILENT_BEFORE_EXIT_MS)}m — a turn's end reaches the box by a hook that can be lost, and a running turn writes as it works; core ended it`,
};

/** How long the session has been over with the subagent silent too, where both pass the bound. */
function overAndSilent(f: RunFacts): number | null {
  const over = f.sessionOverForMs;
  if (over === null || over < RUN_UNANSWERED_RELEASE_AFTER_MS) return null;
  if (f.transcript.kind === 'written' && f.transcript.agoMs < RUN_UNANSWERED_RELEASE_AFTER_MS)
    return null;
  return over;
}

function releaseReason(args: {
  issuesOver: boolean;
  host: RunHostEnd | null;
  unanswered: boolean;
  clockAlone: boolean;
}): string {
  if (args.issuesOver) {
    return 'every issue this run holds has reached a terminal status at core, so nothing further will be done on any of them';
  }
  switch (args.host) {
    case 'pane_gone':
      return "the Claude Code process its subagent ran in is gone, and so is its master's pane, and nothing has been heard from its subagent since; core's session row is terminal";
    case 'pane_started':
      return "the Claude Code process its subagent ran in is gone and its master's pane was started again, and nothing has been heard from its subagent since; core's session row is terminal";
    case 'process_gone':
      return "the Claude Code process its subagent ran in is gone, and nothing has been heard from its subagent since; core's session row is terminal";
    case null:
      break;
  }
  if (args.unanswered && args.clockAlone) {
    return "no master on this box answers for it and core's session row has been terminal for the whole bound; no readable transcript was recorded, so the clock alone decided";
  }
  if (args.unanswered) {
    return "no master on this box answers for it, core's session row is terminal, and its subagent wrote nothing for the whole bound";
  }
  return "the run's process is gone and core's session row is terminal";
}

function settle(
  f: RunFacts,
  close: NonNullable<RunFacts['close']>,
  master: Presence,
  issuesOver: boolean,
): RunVerdict {
  const host = hostEnd(f);
  const agentGone = f.ledgerDead || master === 'gone' || host !== null;
  const unanswered = master === 'unknown' ? overAndSilent(f) : null;
  const owedRelease =
    (agentGone || unanswered !== null || issuesOver) &&
    f.thisBoot &&
    (close.sessionTerminal || issuesOver) &&
    !close.checkoutReturned &&
    !f.releaseDecided;
  const announce = owedRelease && !agentGone && !f.releaseRefused;
  const saidHost = f.ledgerDead ? null : host;
  const notice =
    unanswered !== null && announce
      ? ({ kind: 'unanswered', overMs: unanswered } as const)
      : saidHost !== null && owedRelease && !f.releaseRefused
        ? ({ kind: 'host', how: saidHost } as const)
        : null;
  const deathReport = agentGone && !f.ended && f.thisBoot && !close.sessionTerminal;
  const closed =
    close.sessionTerminal && close.checkoutReturned && close.leasesReturned === close.leasesTotal;
  let standing: RunStanding | null = null;
  if (!owedRelease && !deathReport && !closed) {
    if (f.releaseDecided) standing = 'decided';
    else if (!f.thisBoot) standing = 'foreign_boot';
    else if (master === 'unknown') standing = 'unanswered';
    else standing = 'awaiting_core';
  }
  const release = owedRelease
    ? {
        reason: releaseReason({
          issuesOver,
          host: issuesOver ? null : saidHost,
          unanswered: !agentGone && !issuesOver,
          clockAlone: f.transcript.kind !== 'written',
        }),
        notice,
      }
    : null;
  return {
    act: 'settle',
    release,
    deathReport,
    standing,
    releaseAfterMinutes: minutes(RUN_UNANSWERED_RELEASE_AFTER_MS),
    because: release
      ? `its checkout is owed back: ${release.reason}`
      : deathReport
        ? 'its agent is gone and core still holds its session open, so the box reports the death'
        : standing
          ? `it stands (${standing}) until what is left of its close arrives`
          : 'its close loop is finished',
  };
}

/**
 * Core's verdict on one run the box ledger still holds open (ADR 0009, What core takes over:
 * Recovery verdict). Facts without `close` answer keep, exit or close; facts with the marks the
 * close loop read back answer settle.
 */
export function runVerdict(f: RunFacts, issues: RunIssues): RunVerdict {
  const master = effectiveMaster(f);
  if (f.parkedOnHuman) {
    const reparent = f.master !== 'alive' && f.master !== 'unanswered' && f.liveMasterInProject;
    return {
      act: 'keep',
      beat: f.hasSession,
      reparent,
      sayKept: false,
      because: reparent
        ? "it is parked on a person and its master is not there, so it answers to the project's live master"
        : 'it is parked on a question only a person answers, which no clock ends',
    };
  }
  const end = f.close === null ? (unboundEnd(f) ?? staleEnd(f, issues)) : null;
  if (end !== null) return { act: 'close', end, because: end };
  const orphaned = !f.thisBoot || f.ledgerDead || master !== 'alive';
  const keptSubagent = !orphaned && f.bound && f.process === 'none';
  const issuesOver =
    keptSubagent && issues.over.length === f.issueKeys.length && every(issues.over);
  if (f.close !== null) return settle(f, f.close, master, issuesOver);
  if (!orphaned && !issuesOver) {
    if (keptSubagent) {
      return {
        act: 'keep',
        beat: f.hasSession,
        reparent: false,
        sayKept: keptSaid(f.subagent),
        because:
          "a subagent under a live master ends with its master's close or its issues going over, never with its own silence",
      };
    }
    const cause = f.hasSession ? exitCause(f.activity) : null;
    if (cause !== null) return { act: 'exit', cause, because: EXIT_BECAUSE[cause] };
    return {
      act: 'keep',
      beat: f.hasSession,
      reparent: false,
      sayKept: false,
      because: 'its agent is working',
    };
  }
  return {
    act: 'close',
    end: null,
    because: issuesOver
      ? 'every issue it holds is over at core'
      : 'no live master on this boot answers for it, or its process is gone',
  };
}
