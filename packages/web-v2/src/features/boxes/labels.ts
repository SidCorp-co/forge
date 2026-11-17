// How a box reads on screen: its state's tone, who holds it in a person's words, and the short clock
// its row and feed count in.

import type { BoxRecord, BoxState } from "@forge/contracts/boxes";
import type { LegendTone } from "@/design";
import type { useCopy } from "@/lib/i18n/interface-language";

type Copy = ReturnType<typeof useCopy>;

export const STATE_TONE: Record<BoxState, LegendTone> = {
  waiting: "blocked",
  opening: "neutral",
  warm: "neutral",
  agent: "run",
  person: "you",
  closed: "done",
  failed: "err",
};

export const isRunning = (b: BoxRecord) => b.state === "agent" || b.state === "person" || b.state === "warm";
export const isLive = (b: BoxRecord) => b.state === "agent" || b.state === "person";
export const isEnded = (b: BoxRecord) => b.state === "closed" || b.state === "failed";

/** Whether `userId` holds the box as a person: only they may send it input. */
export const heldBy = (b: BoxRecord, userId: string | undefined) => b.holder?.kind === "person" && !!userId && b.holder.userId === userId;

/** The holder in a person's words: Agent, You, or the person's name. */
export function holderWords(b: BoxRecord, userId: string | undefined, t: Copy): string | null {
  if (!b.holder) return null;
  if (b.holder.kind === "agent") return t("boxes.holder.agent");
  if (b.holder.userId === userId) return t("boxes.holder.you");
  return b.holder.name ?? t("boxes.holder.someone");
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The view's size in words a person reads: `390×844`, from what the box offered or was asked for. */
export function sizeOf(b: BoxRecord): string | null {
  const s = b.view ?? b.viewport;
  return s ? `${s.width}×${s.height}` : null;
}
