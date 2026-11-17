// What a running turn is producing right now (ISS-1268), as the session screen shows it: the live
// turn the event router folds (`lib/ws/live-turn.ts`), its streamed reply as a thread item until the
// transcript holds it, what holds the turn up, and how full its context is. A reload starts from
// the transcript alone.
import { useQuery } from "@tanstack/react-query";
import { type LiveTurn, liveTurnKey } from "@/lib/ws/live-turn";
import type { Copy } from "@/lib/i18n/product-copy";
import type { ConversationItem, RenderBlock } from "./types";

export type { LiveTurn } from "@/lib/ws/live-turn";

/** The live turn of a session, as its frames have built it so far. */
export function useLiveTurn(sessionId: string): LiveTurn | undefined {
  return useQuery<LiveTurn | null>({
    queryKey: liveTurnKey(sessionId),
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
  }).data ?? undefined;
}

/**
 * The streamed reply as a thread item, while the stored transcript does not hold it yet: as it is
 * generated, and after it ended until a read of the transcript newer than its last delta.
 */
export function liveItem(live: LiveTurn | undefined, storedAt: number): ConversationItem | null {
  if (!live || (!live.text && !live.thinking)) return null;
  if (!live.streaming && (live.stoppedAt === null || storedAt >= live.stoppedAt)) return null;
  const blocks: RenderBlock[] = [];
  if (live.thinking) blocks.push({ type: "thinking", text: live.thinking });
  if (live.text) blocks.push({ type: "text", text: live.text });
  return { id: `live-${live.messageId ?? "reply"}`, turnId: "", turnIndex: Number.MAX_SAFE_INTEGER, role: "assistant", kind: "agent", text: "", blocks, attachments: [], editedAt: null, thinkingCount: 0 };
}

/** What the running turn is held up by, in a few words; null where nothing holds it. */
export function liveStatus(live: LiveTurn | undefined, t: Copy, clock: (unixSeconds: number) => string): string | null {
  if (!live || live.ended) return null;
  if (live.rateLimit) {
    return live.rateLimit.resetsAt ? t("session.live.limitedUntil", { at: clock(live.rateLimit.resetsAt) }) : t("session.live.limited");
  }
  if (live.status === "compacting") return t("session.live.compacting");
  if (live.retry) return t("session.live.retrying", { n: live.retry.attempt, of: live.retry.maxRetries });
  return null;
}

/** How full the context is, as a whole percent; null until both figures are known. */
export function contextShare(live: LiveTurn | undefined): number | null {
  const used = live?.context.used;
  const window = live?.context.window;
  if (!used || !window) return null;
  return Math.min(100, Math.round((used / window) * 100));
}
