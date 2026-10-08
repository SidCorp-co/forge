// What a stored chat answer is shared as. Any message of an assistant turn — the reply, a block the
// turn posted above it, the partial it posted while it worked — shares the whole turn: core freezes
// the question, the reply and every block (`packages/core/src/reports/share-source.ts`). A person's
// message, and a turn's recorded silence, offer no share.

import type { ShareSubjectKind } from "@forge/contracts/shares";

export interface ShareSubject {
  kind: ShareSubjectKind;
  id: string;
}

/** The subject a stored message is shared as, or null when it is no part of an answer. */
export function shareSubjectOf(message: {
  id: string;
  role: string;
  content?: string | null | undefined;
  silenceReason?: string | null | undefined;
  blocks?: readonly unknown[] | null | undefined;
}): ShareSubject | null {
  if (message.role !== "assistant" || message.silenceReason) return null;
  const said = (message.content ?? "").trim() !== "";
  const drew = (message.blocks ?? []).some(
    (b) => b !== null && typeof b === "object" && (b as { type?: unknown }).type === "visual",
  );
  return said || drew ? { kind: "message", id: message.id } : null;
}
