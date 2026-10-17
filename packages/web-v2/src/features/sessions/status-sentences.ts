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
};

/** Who can end a blocked session's wait, and what it waits on in the box's own words made a sentence. */
export function waitingOnText(kind: string | null | undefined, waitingOn: string | null | undefined): string {
  const head =
    kind === "nobody"
      ? "Waiting on nobody. This run is a failure with a name."
      : `Waiting on ${kind ? (WAIT_HOLDER[kind] ?? kind) : "someone the box did not name"}.`;
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
