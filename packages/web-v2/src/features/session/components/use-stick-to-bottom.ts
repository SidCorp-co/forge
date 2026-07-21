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
}: {
  conversationKey: string | undefined;
  ready: boolean;
  itemCount: number;
  live: boolean;
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
    if (atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemCount, live]);

  return { scrollRef, bottomRef, onScroll };
}
