import { BLOCKED_WORD, SILENCE_WORD } from "@/design/status";

/**
 * Every sentence the sessions, runs and pipeline surfaces say about a box and core, in one place, so
 * each reads as whole capitalised sentences and two surfaces never word one state two ways.
 */

/** Ends a sentence that does not already end in a stop. */
const stop = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

export function leaseDisagreementText(keys: readonly string[]): string | null {
  if (keys.length === 0) return null;
  const pronoun = keys.length === 1 ? "it" : "them";
  return `The box says it returned ${keys.join(", ")}. Core still holds ${pronoun}. Stop the session to free ${pronoun}.`;
}

export const boxOfflineText = (when: string): string => `The box is offline. It last reported ${when}.`;

/** The box's word on its process against core's on the session, which is the signal rather than an error. */
export type SessionDisagreement = "box-live-core-terminal" | "box-exited-core-running";

const CORE_SAYS: Record<SessionDisagreement, string> = {
  "box-live-core-terminal": "Core says the session ended.",
  "box-exited-core-running": "Core still has the session running.",
};

export const sessionDisagreementText = (d: SessionDisagreement): string =>
  `${d === "box-live-core-terminal" ? "The box says this is live." : "The box says the process is gone."} ${CORE_SAYS[d]}`;

/** What an offline box last said, quoted with when it said it, never in the present tense. */
export const offlineSessionDisagreementText = (d: SessionDisagreement, when: string): string =>
  `${d === "box-live-core-terminal" ? `The box said this was live ${when}` : `The box said the process was gone ${when}`} and is offline now. ${CORE_SAYS[d]}`;

export const ENDING_AS_FAILED = "Core is ending it as failed.";

export const endsAsFailedInText = (countdown: string): string => `Core ends it as failed in ${countdown}.`;

export const quietForText = (since: string, ending: boolean): string =>
  `${SILENCE_WORD}.${ending ? ` ${ENDING_AS_FAILED}` : ""} No report for ${since}.`;

export const coreNoteText = (label: string): string => stop(`Core's note on this session: ${label}`);

/** A quiet session's line on its own page: what it last reported, and how long ago where known. */
export const quietLastReportedText = (lastReported: string, ago: string | null): string =>
  `${SILENCE_WORD}. ${lastReported}${ago ? ` ${ago}` : ""}.`;

export const blockedText = (waitingOn: string | null | undefined): string =>
  waitingOn ? `${BLOCKED_WORD}. ${stop(waitingOn)}` : BLOCKED_WORD;

/** Why a quiet session holds an issue: what it was last doing, and when core last heard from it. */
export const quietWhyText = (doing: string, ago: string): string => `${doing}. Last check-in ${ago}.`;
