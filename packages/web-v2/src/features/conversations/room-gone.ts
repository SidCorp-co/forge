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
    : "It was deleted while you had it open, so it has left your list.";
}

const UNSENT_QUOTE = 200;

/** The thread goes with the room, so the notice keeps what was written (ISS-1229 r29). */
export function unsentLine(text: string): string {
  const quoted = text.length > UNSENT_QUOTE ? `${text.slice(0, UNSENT_QUOTE).trimEnd()}…` : text;
  return `${roomDeletedLine(true)}\nSelect this to copy what you wrote:\n“${quoted}”`;
}
