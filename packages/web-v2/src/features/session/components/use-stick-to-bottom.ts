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
  streamedChars = 0,
}: {
  conversationKey: string | undefined;
  ready: boolean;
  itemCount: number;
  live: boolean;
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

  const lastStreamedRef = useRef(streamedChars);

  // Growth / stream: keep pinned to latest only when already near the bottom.
  useEffect(() => {
    const streamed = streamedChars !== lastStreamedRef.current;
    lastStreamedRef.current = streamedChars;
    if (!atBottomRef.current) return;
    // cm:guard a STREAM step scrolls instantly and a new item still scrolls smoothly, because a
    // smooth scroll feeds back into the guard above it. `scrollIntoView({behavior:"smooth"})`
    // animates through every position between here and the bottom, and each one fires `onScroll`;
    // the moment one of them reads more than 80px short, `atBottomRef` goes false with nobody
    // having touched the page, and the next frame is ignored. It recovers only if the animation
    // reaches its target, and a turn that keeps growing moves the target out from under it — so a
    // reader following a reply that grows by more than the threshold in one frame, a tall tool card
    // most of all, stops being followed for the rest of the turn and never asked to. An instant
    // scroll fires one event, at the destination, which re-affirms the guard instead of tripping
    // it. A new item keeps the animation it has had since ISS-728: it happens once per row, not
    // eight times a second (ISS-1078 review F6, whole-set consult).
    bottomRef.current?.scrollIntoView(streamed ? { block: "end" } : { behavior: "smooth", block: "end" });
  }, [itemCount, live, streamedChars]);

  return { scrollRef, bottomRef, onScroll };
}
