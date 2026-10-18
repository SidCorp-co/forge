import { BLOCKED_WORD, SILENCE_WORD } from "@/design/status";

/**
 * Every sentence the sessions, runs and pipeline surfaces say about a box and core, in one place, so
 * each reads as whole capitalised sentences and two surfaces never word one state two ways.
 */

const stop = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function leaseDisagreementText(keys: readonly string[]): string | null {
  if (keys.length === 0) return null;
  const pronoun = keys.length === 1 ? "it" : "them";
  return `The box says it returned ${keys.join(", ")}. Core still holds ${pronoun}. Stop the session to free ${pronoun}.`;
}

export const boxOfflineText = (when: string): string => `The box is offline. It last reported ${when}.`;

export const BOX_SENT_NO_REPORT = "The box has not reported.";

export const MASTER_HAS_NO_REPORT = "A box reports runs, not masters.";

export interface SilentReap {
  queueTimedOut: number;
  turnNeverReported: number;
  heartbeatTimedOut: number;
  noClientAcked: number;
}

export function endedSilentText(r: SilentReap): string {
  const n = r.queueTimedOut + r.turnNeverReported + r.heartbeatTimedOut + r.noClientAcked;
  return n === 0 ? "No session was silent." : `Ended ${n} silent session${n === 1 ? "" : "s"}.`;
}

export type SessionDisagreement = "box-live-core-terminal" | "box-exited-core-running";

const CORE_SAYS: Record<SessionDisagreement, string> = {
  "box-live-core-terminal": "Core says the session ended.",
  "box-exited-core-running": "Core still has the session running.",
};

export const sessionDisagreementText = (d: SessionDisagreement): string =>
  `${d === "box-live-core-terminal" ? "The box says this is live." : "The box says the process is gone."} ${CORE_SAYS[d]}`;

export const offlineSessionDisagreementText = (d: SessionDisagreement, when: string): string =>
  `${d === "box-live-core-terminal" ? `The box said this was live ${when}` : `The box said the process was gone ${when}`} and is offline now. ${CORE_SAYS[d]}`;

export const ENDING_AS_FAILED = "Core is ending it as failed.";

export const endsAsFailedInText = (countdown: string): string => `Core ends it as failed in ${countdown}.`;

/** Silence is a missing check-in, never a missing report: the box's report is the row's other clock. */
export const quietForText = (since: string, ending: boolean): string =>
  `${SILENCE_WORD}.${ending ? ` ${ENDING_AS_FAILED}` : ""} No check-in for ${since}.`;

export const coreNoteText = (label: string): string => stop(`Core's note on this session: ${label}`);

export const quietLastReportedText = (lastReported: string, ago: string | null): string =>
  `${SILENCE_WORD}. ${lastReported}${ago ? ` ${ago}` : ""}.`;

const WAIT_HOLDER: Record<string, string> = {
  machine: "a machine",
  master_or_peer: "another agent",
  human: "a person",
  nobody: "nobody",
};

const waitHolder = (kind: string | null | undefined): string =>
  kind ? (WAIT_HOLDER[kind] ?? kind) : "someone the box did not name";

/** Who can end a blocked session's wait, and what it waits on in the box's own words made a sentence. */
export function waitingOnText(kind: string | null | undefined, waitingOn: string | null | undefined): string {
  const head =
    kind === "nobody"
      ? "Waiting on nobody. This run is a failure with a name."
      : `Waiting on ${waitHolder(kind)}.`;
  const words = waitingOn?.trim();
  return words ? `${head} ${stop(capitalised(words))}` : head;
}

/** A blocked session's line where nothing beside it says Blocked: the word, then its wait. */
export const blockedText = (waiting: string | null | undefined): string =>
  waiting ? `${BLOCKED_WORD}. ${waiting}` : `${BLOCKED_WORD}.`;

export const PERSON_STOPPED = "A person stopped the session.";

/** Why a session ended, where core recorded a reason: `label` is that reason in words. */
export const sessionEndedText = (reason: string, label: string | null): string =>
  reason === "user_cancelled" ? PERSON_STOPPED : `The session ended. ${stop(capitalised(label ?? reason))}`;

export const quietWhyText = (doing: string, ago: string): string => `${doing}. Last check-in ${ago}.`;

export const ENDS_AS_FAILED_HOVER = "Core ends a session as failed once it stays silent this long.";

export const CHAT_TAG_HOVER = "An interactive chat. It spawns no pipeline job, so a running chat is not a wedged box.";

export const PRIMARY_BOX_HOVER = "This is the project's primary box, its pinned default.";

const sessionsCount = (n: number): string => `${n} session${n === 1 ? "" : "s"}`;
const isAre = (n: number): string => (n === 1 ? "is" : "are");

/** A box's queue figure on the box strip, on hover. */
export const queuedBehindText = (n: number): string =>
  n === 0 ? "No session is queued behind this box." : `${sessionsCount(n)} ${isAre(n)} queued behind this box.`;

export const runningChatsText = (n: number): string =>
  `${n} chat${n === 1 ? " has a turn" : "s have turns"} running.`;

export const DISPATCH_STALLED = "Dispatch stalled. No box is online.";

/** Beside {@link DISPATCH_STALLED}: what waits, and what ends the wait. */
export const queuedWithNoBoxText = (n: number): string =>
  `${sessionsCount(n)} ${isAre(n)} queued with no box to pick ${n === 1 ? "it" : "them"} up. Bring a box online or check its pairing.`;

/** What a run on the runs tab means, by what its box reports of its process and its work. */
export const RUN_DETAIL = {
  working: "An agent is running in this worktree.",
  answered: "The answer is on the record, and nothing has restarted this run yet.",
  closed: "The close loop finished.",
  unknown: "The box reported a combination this build does not name. Nothing may be reclaimed.",
  quiet: "The box last reported this. Core has heard nothing from the run's session since.",
  ended: "Core ended this run's session. This is what the box last reported, not what is happening.",
} as const;

/** A blocked run's chip hover, naming the holder its row's wait line names; `parkedText` likewise. */
export const blockedHoldingText = (kind: string | null | undefined): string =>
  `It waits on ${waitHolder(kind)}, and keeps its process while it waits.`;

export const parkedText = (kind: string | null | undefined): string =>
  `The process is gone. It waits on ${waitHolder(kind)}, and the worktree and the branch are kept until the wait ends.`;

/** What each time on a session page's Timing row is, on hover; true of a live and an ended session alike. */
export const TIMING_HOVER = {
  dispatched: "When core offered this session to a box.",
  started: "When the agent on the box started.",
  ended: "When core ended this session. A session core still holds shows a dash.",
} as const;

export const RUN_APPEARS = "A run appears here as soon as a master opens one on a box serving this project.";

export const NO_RUN_WORKING = "No run is working on this project right now.";

export const NO_BOX_REPORTS_A_RUN = "No box reports a run on this project right now.";

/** Where no box reports a run though core counts open runs with work behind them. */
export const noBoxReportsButWorkedText = (worked: number): string =>
  `No box reports a run here, though ${worked} open ${worked === 1 ? "run has" : "runs have"} work behind ${worked === 1 ? "it" : "them"}.`;

/** Why an ended session's chip reads what it reads, on hover. */
export const OUTCOME_HOVER = {
  completed: "It finished cleanly.",
  sweptStale: "Core swept it after it went stale with no recent check-in. This is automatic cleanup, not a failure.",
  stopped: "It was stopped on purpose. This is not a failure.",
  personStopped: "A person stopped this session. This is not a failure.",
  cleanedUp: "Core cleaned this step up when the pipeline finished. This is not a failure.",
  ruleEnded: "Core ended it by a lifecycle or capacity rule. This is not a failure.",
  failed: "The agent step failed. See the run timeline.",
} as const;

/** What the session page's Declaration gate says about the box's gate when its run opened. */
export const GATE_TEXT = {
  unfetched: "This run's record could not be read, so its gate condition is unknown.",
  none: "The box reported no gate condition when this run opened.",
  noneDetail: "Its runner sent none, so this record cannot say whether the gate was deciding.",
  unreadable: "This run recorded a gate condition that cannot be read.",
  clear: "This box's gate was deciding when this run opened.",
  clearDetail: "No dispatch on record had gone through without a decision.",
  failingOpen: "This box's gate was failing open when this run opened.",
  marked: "This box's gate had admitted undecided dispatches when this run opened.",
} as const;

/** The record's reason a gate condition cannot be read, made the sentence it is. */
export const gateUnreadableDetailText = (reason: string): string =>
  `The record says why: ${stop(reason)} The run was not opened with no condition, so this is not "the gate was deciding".`;

/** How many dispatches the gate admitted without a decision, at what rate and over what span. */
export const gateAdmittedText = (count: number, rate: string, window: string): string =>
  `${count} dispatch${count === 1 ? " was" : "es were"} admitted without a decision, ${rate} over ${window}.`;

/** Which reason the gate's admissions were for, as the Declaration gate's own sentence. */
export const gateReasonText = (line: string): string => stop(capitalised(line));
