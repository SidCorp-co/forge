import { useEffect, useRef } from "react";

/**
 * Auto-scroll a thread container to its newest message (ISS-522, ISS-728).
 * The container opens at the OLDEST turn otherwise (turns render
 * oldest→newest), forcing the user to scroll far down. Strategy:
 *  - jump to bottom (instant) on conversation switch + once the conversation's
 *    items first load (one-shot via lastJumpedKeyRef);
 *  - stick to bottom (smooth) on new turn / stream change ONLY when the user
 *    is already near the bottom, so reading history isn't interrupted (AC3).
 */
export function useStickToBottom({
  conversationKey,
  ready,
  itemCount,
  live,
  streaming = false,
  streamedChars = 0,
}: {
  conversationKey: string | undefined;
  ready: boolean;
  itemCount: number;
  live: boolean;
  /**
   * Whether a turn is arriving into this thread right now.
   */
  // cm:guard this is NOT `live`, and the difference is the second person in the room: `live` is
  // whether THIS browser has a send in flight, so a reader who is only watching has it false for a
  // turn they can see streaming. What this asks is whether anything is arriving, from anyone
  // (ISS-1078 review F6, whole-set consult round 2).
  streaming?: boolean;
  /**
   * How much the turn currently streaming has grown.
   */
  // cm:guard a THIRD dependency, because neither of the other two moves while a turn streams into
  // the thread: one in-flight entry is one item however long it gets, and `live` is a boolean that
  // was already true when the turn began. So the effect below ran once, on the first frame, and a
  // reader pinned to the bottom then watched the reply grow off the end of the viewport — on the
  // screen ISS-1078 shipped to make that reply watchable. The near-bottom guard is untouched, so
  // somebody reading history is still never moved (ISS-1078 review F6).
  streamedChars?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastJumpedKeyRef = useRef<string | undefined>(undefined);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Conversation switch: reset the one-shot guard and jump to bottom once the
  // freshly-resolved conversation's items have loaded.
  useEffect(() => {
    if (!conversationKey || !ready) return;
    if (lastJumpedKeyRef.current === conversationKey) return;
    lastJumpedKeyRef.current = conversationKey;
    atBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversationKey, ready]);

  // Growth / stream: keep pinned to latest only when already near the bottom.
  useEffect(() => {
    if (!atBottomRef.current) return;
    // cm:guard NOTHING animates while a turn is arriving, and that covers the row as well as the
    // frame, because a smooth scroll feeds back into the guard above it. `scrollIntoView({behavior:"smooth"})`
    // animates through every position between here and the bottom, and each one fires `onScroll`;
    // the moment one of them reads more than 80px short, `atBottomRef` goes false with nobody
    // having touched the page, and the next frame is ignored. It recovers only if the animation
    // reaches its target, and a turn that keeps growing moves the target out from under it — so a
    // reader following a reply that grows by more than the threshold in one frame, a tall tool card
    // most of all, stops being followed for the rest of the turn and never asked to. An instant
    // scroll fires one event, at the destination, which re-affirms the guard instead of tripping
    // it. Outside a turn a new item keeps the animation it has had since ISS-728: it happens once
    // per row, with nothing arriving behind it to be dropped.
    // cm:guard the branch is on WHETHER A TURN IS ARRIVING and not on which dependency moved, which
    // is where the first version of this fix was still wrong: a reader may queue a follow-up while
    // the reply streams — the composer takes one, `queueWhileBusy` — and that moves `itemCount`
    // alone. Branching on the changed dependency animated exactly that row, mid-stream, which is
    // the one sequence that trips the guard and then has no recovery, because every frame after it
    // returns at the guard instead of re-affirming it. One overlapping animation is enough; the
    // frequency was never the deciding factor (ISS-1078 review F6, whole-set consult rounds 1-2).
    bottomRef.current?.scrollIntoView(
      streaming ? { block: "end" } : { behavior: "smooth", block: "end" },
    );
  }, [itemCount, live, streaming, streamedChars]);

  return { scrollRef, bottomRef, onScroll };
}
