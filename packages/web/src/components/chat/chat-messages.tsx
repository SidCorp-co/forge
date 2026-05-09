'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { ArrowDown, MessageSquare, Search, X } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChatMessage } from './chat-message';
import type { ChatMessageData } from './chat-message';
import { InlineDiffSummary } from './chat-message/inline-diff-summary';
import { SessionPlaceholder } from './session-placeholder';

interface ChatMessagesProps {
  messages: ChatMessageData[];
  variant?: 'agent' | 'chat';
  /**
   * When set + `messages` is empty, render a pipeline-aware placeholder
   * (Status / Worker / Issue / Retry-Cancel) instead of the generic
   * "Ask anything…" empty state. The placeholder fetches the session row
   * itself, so a route that opens a pipeline session via `?session=…` can
   * just thread the id through without any extra plumbing.
   */
  sessionId?: string | null;
  onAfterEdit?: () => void;
  onAfterRegenerate?: () => void;
  onAfterFork?: (newSessionDocumentId: string) => void;
  /** When set, scroll the matching turn into view and flash a highlight ring. */
  highlightTurnId?: string | null;
}

export function ChatMessages({
  messages,
  variant = 'agent',
  sessionId,
  onAfterEdit,
  onAfterRegenerate,
  onAfterFork,
  highlightTurnId,
}: ChatMessagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const isNearBottom = useRef(true);

  const matchingIds = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase();
    return new Set(
      messages
        .filter((m) => m.content.toLowerCase().includes(q))
        .map((m) => m.id)
    );
  }, [messages, searchQuery]);

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 240,
    overscan: 8,
    getItemKey: (index) => messages[index].id,
  });

  const scrollToBottom = useCallback((smooth = true) => {
    if (messages.length === 0) {
      const el = containerRef.current;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      }
      return;
    }
    // Defer one frame so initial-mount paint can run measureElement before
    // we land on the last row — otherwise scrollToIndex(last) computes the
    // offset off the estimate and lands short on long histories.
    requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(messages.length - 1, {
        align: 'end',
        behavior: smooth ? 'smooth' : 'auto',
      });
    });
  }, [messages.length, rowVirtualizer]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 100;
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    setShowScrollBtn(!isNearBottom.current);
  }, []);

  useEffect(() => {
    if (isNearBottom.current) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  // Guarded by ref so streaming token updates don't re-trigger the highlight.
  const flashedTurnIdRef = useRef<string | null>(null);
  // Stable ref to messages so the permalink effect doesn't depend on the
  // array reference (which changes per WS streaming delta) — the lookup
  // only runs once per highlightTurnId, not per token.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    if (!highlightTurnId || flashedTurnIdRef.current === highlightTurnId) return;
    const idx = messagesRef.current.findIndex((m) => m.turnId === highlightTurnId);
    if (idx === -1) return;
    flashedTurnIdRef.current = highlightTurnId;
    rowVirtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' });

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const cls = ['ring-2', 'ring-primary', 'ring-offset-2', 'rounded'];

    const tryFlash = (attemptsLeft: number) => {
      if (cancelled) return;
      const node = containerRef.current?.querySelector<HTMLElement>(
        `[data-turn-id="${highlightTurnId}"]`,
      );
      if (node) {
        node.classList.add(...cls);
        timeoutId = setTimeout(() => node.classList.remove(...cls), 2000);
        return;
      }
      if (attemptsLeft > 0) {
        requestAnimationFrame(() => tryFlash(attemptsLeft - 1));
      }
    };
    // ~10 frames (~166ms) is enough for the virtualizer to mount the target
    // row after a smooth scroll on typical histories.
    requestAnimationFrame(() => tryFlash(10));

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [highlightTurnId, rowVirtualizer]);

  if (messages.length === 0) {
    if (sessionId) {
      return <SessionPlaceholder sessionId={sessionId} />;
    }
    return (
      <div className="flex-1 flex items-center justify-center bg-surface">
        <div className="text-center">
          <MessageSquare className="h-10 w-10 text-on-surface-variant mx-auto mb-3" />
          <p className="text-sm font-sans text-on-surface-variant">Ask anything about this project</p>
        </div>
      </div>
    );
  }

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Search bar */}
      {searchOpen ? (
        <div className="flex items-center gap-2 border-b border-outline-variant/30 bg-surface-container-low px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages..."
            className="flex-1 bg-transparent text-[16px] sm:text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none"
          />
          {matchingIds && (
            <span className="shrink-0 text-[10px] text-on-surface-variant">
              {matchingIds.size} match{matchingIds.size !== 1 ? 'es' : ''}
            </span>
          )}
          <button
            onClick={() => { setSearchOpen(false); setSearchQuery(''); }}
            className="shrink-0 p-1 text-on-surface-variant hover:text-on-surface-variant"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setSearchOpen(true)}
          className="absolute right-3 top-2 z-10 rounded-full bg-surface-container border border-outline-variant/30 p-1.5 text-on-surface-variant hover:text-on-surface-variant transition-colors"
          title="Search messages"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
      )}

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4 bg-surface"
      >
        <div
          style={{
            height: totalSize,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((virtualRow) => {
            const msg = messages[virtualRow.index];
            const dimmed = matchingIds !== null && !matchingIds.has(msg.id);
            return (
              <div
                key={virtualRow.key}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                data-turn-id={msg.turnId ?? undefined}
                className={`pb-3 ${dimmed ? 'opacity-20' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <ChatMessage
                  message={msg}
                  variant={variant}
                  sessionId={sessionId ?? null}
                  onAfterEdit={onAfterEdit}
                  onAfterRegenerate={onAfterRegenerate}
                  onAfterFork={onAfterFork}
                />
              </div>
            );
          })}
        </div>
        <InlineDiffSummary messages={messages} />
      </div>
      {showScrollBtn && (
        <button
          onClick={() => scrollToBottom()}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-surface-container border border-outline-variant/30 shadow-md px-3 py-2 text-xs text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          <ArrowDown className="h-3 w-3" />
          Scroll to bottom
        </button>
      )}
    </div>
  );
}
