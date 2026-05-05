'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { ArrowDown, MessageSquare, Search, X } from 'lucide-react';
import { ChatMessage } from './chat-message';
import type { ChatMessageData } from './chat-message';
import { DiffSummary } from './chat-message/diff-summary';
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
}

export function ChatMessages({ messages, variant = 'agent', sessionId }: ChatMessagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
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

  const scrollToBottom = useCallback((smooth = true) => {
    const el = containerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    }
  }, []);

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
        className="h-full overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4 space-y-3 bg-surface"
      >
        {messages.map((msg) => {
          const dimmed = matchingIds !== null && !matchingIds.has(msg.id);
          return (
            <div key={msg.id} className={dimmed ? 'opacity-20' : undefined}>
              <ChatMessage message={msg} variant={variant} />
            </div>
          );
        })}
        <DiffSummary messages={messages} />
        <div ref={bottomRef} />
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
