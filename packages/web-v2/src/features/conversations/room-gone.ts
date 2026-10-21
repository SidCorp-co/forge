// Core cannot tell a deleted room from an unknown id; the web had this one open (ISS-1229 r28).

import { ApiError } from "@/lib/api/client";

export const ROOM_GONE_CODE = "CONVERSATION_GONE";

export function isRoomGone(err: unknown): boolean {
  return err instanceof ApiError && err.code === ROOM_GONE_CODE;
}

export const ROOM_DELETED_TITLE = "This room was deleted";

export function roomDeletedLine(sending: boolean): string {
  return sending
    ? "It was deleted while you had it open, so your message was not sent."
    : "It has left your list.";
}

const UNSENT_QUOTE = 200;

/**
 * Where a kept notice stands with its text: offered to copy with a tap, copied, or to be copied by hand,
 * either because this browser has no clipboard or because it refused the copy (ISS-1229 r32, judge-90).
 */
export type KeptCopy = "offered" | "copied" | "by-hand" | "refused";

/**
 * The thread goes with the room, so the notice quotes what was written, its outer blank space aside
 * (r29, r30). Only a message the reader sent "was not sent"; text still in the box is kept (r31). Text to
 * be copied by hand is quoted whole and as typed, since what the quote leaves out could not be selected
 * (r32); its toast is asked to keep that text's spaces (`verbatim`).
 */
export function unsentLine(text: string, sent: boolean, copy: KeptCopy = "offered"): string {
  const byHand = copy === "by-hand" || copy === "refused";
  const shown = text.trim();
  // Selected by hand, the quote is the text exactly as typed, as an automatic copy writes it (r32 F1).
  const quoted = byHand
    ? text
    : shown.length > UNSENT_QUOTE
      ? `${shown.slice(0, UNSENT_QUOTE).trimEnd()}…`
      : shown;
  const context = sent
    ? roomDeletedLine(true)
    : "It was deleted while you had it open. What you were writing is kept below.";
  const lead: Record<KeptCopy, string> = {
    offered: sent
      ? `${roomDeletedLine(true)}\nSelect this to copy what you wrote:`
      : "It was deleted while you had it open.\nWhat you were writing is kept below — select it to copy.",
    copied: "What you wrote was copied. Select this to copy it again:",
    "by-hand": `${context}\nSelect the text below and copy it by hand:`,
    refused: "It could not be copied here. Select the text below and copy it by hand:",
  };
  return `${lead[copy]}\n“${quoted}”`;
}
