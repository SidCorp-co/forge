import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationItem } from "../types";

/**
 * Auto-scroll a thread container to its newest message (ISS-522, ISS-728).
 * The container opens at the OLDEST turn otherwise (turns render
 * oldest→newest), forcing the user to scroll far down. Strategy:
 *  - jump to bottom (instant) on conversation switch + once the conversation's
 *    items first load (one-shot via lastJumpedKeyRef);
 *  - stick to bottom (smooth) on new turn / stream change ONLY when the user
 *    is already near the bottom, so reading history isn't interrupted (AC3).
 *
 * Since ISS-1083 it also reports what it knows about the reader, because two
 * behaviours outside this file turn on it: a reader who has scrolled up is TOLD
 * there is new output (criterion 28) rather than left to find out by scrolling
 * back, and history only folds its machinery while they are at the bottom
 * (criterion 29).
 */
/**
 * How much the thread's newest turn currently holds, as a number that moves whenever it does.
 */
// cm:guard the session screen passed NO growth signal at all until ISS-1083, so it still carried the
// defect PR #480 fixed for the chat panel: a turn's rows grow IN PLACE while it runs, so `itemCount`
// does not move and `live` was already true — the thread followed the first frame and then stopped,
// and a reader up the thread was never told the rest had arrived (scroll consult F3).
//
// cm:why the whole turn serialized rather than its text length: a tool result settling onto a card
// adds height to the thread and no characters to its prose, and a signal that missed it would drop a
// reader following a turn at the exact moment the turn got taller. It is the same derivation
// `conversation-chat.tsx` makes over the progress entry, for the same reason.
export function tailOutputSize(items: readonly ConversationItem[]): number {
  const tail = items.length > 0 ? items[items.length - 1] : undefined;
  return tail ? JSON.stringify(tail).length : 0;
}

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

  // cm:guard the ref stays and the state is BESIDE it rather than replacing it: every read below is
  // inside an effect that must see the reader's position as it is at that instant, and a state
  // variable captured in a closure is the position at the last render. The state exists only so a
  // reader's position can change what is DRAWN, which a ref cannot do.
  const [atBottom, setAtBottom] = useState(true);
  const [newOutput, setNewOutput] = useState(false);
  const lastOutputRef = useRef(`${itemCount}:${streamedChars}`);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
    // Both setters are no-ops where the value is unchanged, so a scroll gesture costs a render only
    // when it crosses the threshold.
    setAtBottom(near);
    if (near) setNewOutput(false);
  };

  /** Take the reader to the newest output, because they asked for it. */
  // cm:guard INSTANT, for the reason the growth effect below gives at length: a smooth scroll
  // animates through every position on the way down and each one fires `onScroll`, so one reading
  // more than 80px short drops the reader mid-turn with nobody having touched the page. This is
  // reached by a click, which is exactly when a turn is most likely to be streaming underneath it.
  const toBottom = useCallback(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    setNewOutput(false);
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, []);

  // Conversation switch: reset the one-shot guard and jump to bottom once the
  // freshly-resolved conversation's items have loaded.
  useEffect(() => {
    if (!conversationKey || !ready) return;
    if (lastJumpedKeyRef.current === conversationKey) return;
    lastJumpedKeyRef.current = conversationKey;
    atBottomRef.current = true;
    setAtBottom(true);
    setNewOutput(false);
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversationKey, ready]);

  // Growth / stream: keep pinned to latest only when already near the bottom.
  useEffect(() => {
    // cm:guard a reader who has scrolled up is not moved AND is not left uninformed, which are two
    // halves of one behaviour: ISS-1078 built the first half and shipped the second as silence, so a
    // person who scrolled up to re-read a tool result while an answer streamed had no way to know
    // the answer had finished except to scroll down and look (ISS-1083 criterion 28).
    // cm:guard the pill is raised only where OUTPUT moved, and never where a lifecycle dependency
    // did: this effect also runs when `live` or `streaming` flips, which happens when a send
    // resolves or a turn ends with nothing having arrived — and a reader up the thread was told
    // there was new output when there was none (scroll consult F2). The scroll below still runs on
    // any of the four, because a reader at the bottom follows the thread whatever moved it.
    const output = `${itemCount}:${streamedChars}`;
    const grew = output !== lastOutputRef.current;
    lastOutputRef.current = output;
    if (!atBottomRef.current) {
      if (grew) setNewOutput(true);
      return;
    }
    setNewOutput(false);
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

  return { scrollRef, bottomRef, onScroll, atBottom, newOutput, toBottom };
}
