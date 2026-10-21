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
 * The thread goes with the room, so the notice quotes what was written, its outer blank space aside
 * (r29, r30). Only a message the reader sent "was not sent"; text still in the box is kept (r31).
 */
export function unsentLine(text: string, sent: boolean, copied = false): string {
  const shown = text.trim();
  const quoted = shown.length > UNSENT_QUOTE ? `${shown.slice(0, UNSENT_QUOTE).trimEnd()}…` : shown;
  const lead = sent
    ? `${roomDeletedLine(true)}\nSelect this to copy what you wrote:`
    : "It was deleted while you had it open.\nWhat you were writing is kept below — select it to copy.";
  return `${copied ? "What you wrote was copied. Select this to copy it again:" : lead}\n“${quoted}”`;
}
