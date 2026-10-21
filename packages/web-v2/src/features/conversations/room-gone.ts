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

/** A kept notice's text: offered to copy, copied, or to copy by hand (no clipboard, or it refused). */
export type KeptCopy = "offered" | "copied" | "by-hand" | "refused";

/**
 * The notice quotes what was written, trimmed (r29, r30); only a message the reader sent "was not sent"
 * (r31). Text to copy by hand is quoted whole and as typed, for a `verbatim` toast (r32).
 */
export function unsentLine(text: string, sent: boolean, copy: KeptCopy = "offered"): string {
  const byHand = copy === "by-hand" || copy === "refused";
  const shown = text.trim();
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
