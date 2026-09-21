import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationItem } from "../types";

/**
 * How much the thread's newest turn currently holds, as a number that moves whenever it does.
 */
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
  streaming?: boolean;
  /**
   * How much the turn currently streaming has grown.
   */
  streamedChars?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastJumpedKeyRef = useRef<string | undefined>(undefined);

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
    const output = `${itemCount}:${streamedChars}`;
    const grew = output !== lastOutputRef.current;
    lastOutputRef.current = output;
    if (!atBottomRef.current) {
      if (grew) setNewOutput(true);
      return;
    }
    setNewOutput(false);
    bottomRef.current?.scrollIntoView(
      streaming ? { block: "end" } : { behavior: "smooth", block: "end" },
    );
  }, [itemCount, live, streaming, streamedChars]);

  return { scrollRef, bottomRef, onScroll, atBottom, newOutput, toBottom };
}
