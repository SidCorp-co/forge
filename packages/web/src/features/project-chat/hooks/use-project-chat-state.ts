'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';

export type ChatTab = 'sessions' | 'chat';

interface ProjectChatState {
  isOpen: boolean;
  tab: ChatTab;
  sessionId: string | null;
  open: (opts?: { tab?: ChatTab; sessionId?: string | null }) => void;
  close: () => void;
  toggle: () => void;
  setTab: (tab: ChatTab) => void;
  setSessionId: (sessionId: string | null) => void;
}

/**
 * Bubble open/close state mirrored into URL query params so a reload reopens
 * the same session. Listens for Escape to close. Single source of truth keyed
 * off `?chat=open` + `?chatSession=<id>`.
 */
export function useProjectChatState(): ProjectChatState {
  const router = useRouter();
  const searchParams = useSearchParams();

  const isOpen = searchParams.get('chat') === 'open';
  const sessionId = searchParams.get('chatSession');
  const rawTab = searchParams.get('chatTab');
  const tab: ChatTab = rawTab === 'sessions' ? 'sessions' : 'chat';

  // Coalesce multiple synchronous mutations into one router.replace so that
  // chained calls like `setSessionId(id); setTab('chat')` don't clobber each
  // other (each would otherwise read the same pre-replace `searchParams`
  // snapshot). Mutations accumulate on `pendingRef` and flush in a microtask.
  const pendingRef = useRef<URLSearchParams | null>(null);
  const flushScheduledRef = useRef(false);

  const updateParams = useCallback(
    (mut: (params: URLSearchParams) => void) => {
      if (!pendingRef.current) {
        pendingRef.current = new URLSearchParams(searchParams.toString());
      }
      mut(pendingRef.current);
      if (!flushScheduledRef.current) {
        flushScheduledRef.current = true;
        queueMicrotask(() => {
          flushScheduledRef.current = false;
          const params = pendingRef.current;
          pendingRef.current = null;
          if (!params) return;
          const qs = params.toString();
          router.replace(qs ? `?${qs}` : '?', { scroll: false });
        });
      }
    },
    [router, searchParams],
  );

  const open = useCallback(
    (opts?: { tab?: ChatTab; sessionId?: string | null }) => {
      updateParams((p) => {
        p.set('chat', 'open');
        if (opts?.tab) p.set('chatTab', opts.tab);
        if (opts && 'sessionId' in opts) {
          if (opts.sessionId) p.set('chatSession', opts.sessionId);
          else p.delete('chatSession');
        }
      });
    },
    [updateParams],
  );

  const close = useCallback(() => {
    updateParams((p) => {
      p.delete('chat');
      p.delete('chatTab');
    });
  }, [updateParams]);

  const toggle = useCallback(() => {
    if (isOpen) close();
    else open();
  }, [isOpen, open, close]);

  const setTab = useCallback(
    (next: ChatTab) => updateParams((p) => p.set('chatTab', next)),
    [updateParams],
  );

  const setSessionId = useCallback(
    (next: string | null) =>
      updateParams((p) => {
        if (next) p.set('chatSession', next);
        else p.delete('chatSession');
      }),
    [updateParams],
  );

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  return useMemo(
    () => ({ isOpen, tab, sessionId, open, close, toggle, setTab, setSessionId }),
    [isOpen, tab, sessionId, open, close, toggle, setTab, setSessionId],
  );
}
