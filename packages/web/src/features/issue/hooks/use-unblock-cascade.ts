'use client';

import { useEffect, useRef, useState } from 'react';
import { wsClient } from '@/lib/ws/client';

interface DependentRef {
  issueId: string;
  issSeq: number;
}

export interface UnblockToast {
  id: string;
  blockerId: string;
  blockerIssSeq: number | null;
  dependents: DependentRef[];
  overflow: number;
}

interface UnblockCascadePayload {
  blockerId: string;
  blockerIssSeq: number | null;
  dependents: DependentRef[];
  overflow: number;
  at: string;
  // The server publishes to a single project room, but the client receives
  // the envelope without an explicit projectId field. The hook is mounted
  // inside the per-project layout, so we only see events for the current
  // project's room — no extra filter is needed.
}

interface DependencyUnblockedPayload {
  issueId: string;
  blockerId: string | null;
  at: string;
}

/** How long an unblocked-row tooltip lingers before auto-clearing. */
const UNBLOCKED_TTL_MS = 10_000;

/** How long an unblock toast stays visible before auto-dismiss. */
const TOAST_TTL_MS = 4_000;

/**
 * Subscribe to `issue.unblockCascade` events for the current project room and
 * surface them as transient toasts. Returns the rolling toast list and a
 * dismiss callback. Auto-dismisses after `TOAST_TTL_MS`.
 *
 * The hook listens through `wsClient.on` (singleton). The mounting layout is
 * already subscribed to the project room via `useRoom(projectRoom(...))`, so
 * we only ever receive envelopes for that room.
 */
export function useUnblockToasts(): {
  toasts: UnblockToast[];
  dismiss: (id: string) => void;
} {
  const [toasts, setToasts] = useState<UnblockToast[]>([]);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const off = wsClient.on((env) => {
      if (env.event !== 'issue.unblockCascade') return;
      const data = env.data as UnblockCascadePayload | undefined;
      if (!data || !Array.isArray(data.dependents) || data.dependents.length === 0) {
        return;
      }
      const id = `${data.blockerId}-${data.at}`;
      const toast: UnblockToast = {
        id,
        blockerId: data.blockerId,
        blockerIssSeq: data.blockerIssSeq ?? null,
        dependents: data.dependents,
        overflow: data.overflow ?? 0,
      };
      setToasts((prev) =>
        prev.some((t) => t.id === id) ? prev : [...prev, toast],
      );
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        timersRef.current.delete(timer);
      }, TOAST_TTL_MS);
      timersRef.current.add(timer);
    });
    return () => {
      off();
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current.clear();
    };
  }, []);

  return {
    toasts,
    dismiss: (id) => setToasts((prev) => prev.filter((t) => t.id !== id)),
  };
}

/** Window during which a cached blocker→seq mapping (from `issue.unblockCascade`)
 *  remains usable when the matching `dependency.unblocked` event arrives. The
 *  dispatcher has a 60s backstop sweep, so 90s gives a buffer. */
const SEQ_CACHE_TTL_MS = 90_000;

/**
 * Subscribe to `dependency.unblocked` events and expose a Set of issueIds
 * that have been unblocked in the last `UNBLOCKED_TTL_MS`. The pulse fires
 * only when the dispatcher actually re-dispatches a previously-gated session
 * — the cascade event preceeds it by 1–60s and is used solely to pre-cache
 * the blocker's `issSeq` so the row tooltip can render `Unblocked by ISS-X`.
 *
 * Runs a 1-second sweep to drop expired live entries so subscribers re-render
 * naturally as the rolling window slides.
 */
export function useUnblockedIssueIds(): {
  ids: Set<string>;
  blockerSeqFor: (issueId: string) => number | null;
} {
  const [snapshot, setSnapshot] = useState<{ ids: Set<string>; map: Map<string, number | null> }>(
    () => ({ ids: new Set(), map: new Map() }),
  );
  // Active = dependent has been dispatched (pulse the row).
  const activeRef = useRef<Map<string, number>>(new Map()); // issueId -> expiresAt
  // Seq cache = pre-stamped from cascade events, lets the pulse render
  // `Unblocked by ISS-X` even though `dependency.unblocked` only carries
  // blockerId (a UUID, not a seq).
  const seqCacheRef = useRef<Map<string, { issSeq: number; expiresAt: number }>>(new Map());

  useEffect(() => {
    function publishSnapshot(force = false) {
      const now = Date.now();
      let changed = false;
      // Drop expired live entries.
      for (const [issueId, expiresAt] of activeRef.current) {
        if (expiresAt <= now) {
          activeRef.current.delete(issueId);
          changed = true;
        }
      }
      // Drop expired seq-cache entries to avoid unbounded growth (does not
      // by itself need a re-render — the live set is what drives the UI).
      for (const [id, c] of seqCacheRef.current) {
        if (c.expiresAt <= now) seqCacheRef.current.delete(id);
      }
      if (!force && !changed) return;
      const live = new Set<string>();
      const map = new Map<string, number | null>();
      for (const [issueId, expiresAt] of activeRef.current) {
        if (expiresAt <= now) continue;
        live.add(issueId);
        const cached = seqCacheRef.current.get(issueId);
        map.set(issueId, cached && cached.expiresAt > now ? cached.issSeq : null);
      }
      setSnapshot({ ids: live, map });
    }

    const off = wsClient.on((env) => {
      if (env.event !== 'dependency.unblocked') return;
      const data = env.data as DependencyUnblockedPayload | undefined;
      if (!data?.issueId) return;
      activeRef.current.set(data.issueId, Date.now() + UNBLOCKED_TTL_MS);
      publishSnapshot(true);
    });

    const offCascade = wsClient.on((env) => {
      if (env.event !== 'issue.unblockCascade') return;
      const data = env.data as UnblockCascadePayload | undefined;
      if (!data?.blockerIssSeq) return;
      const expiresAt = Date.now() + SEQ_CACHE_TTL_MS;
      for (const dep of data.dependents ?? []) {
        seqCacheRef.current.set(dep.issueId, { issSeq: data.blockerIssSeq, expiresAt });
      }
      // No snapshot publish — cascade alone never lights up a row.
    });

    const sweep = setInterval(publishSnapshot, 1000);
    return () => {
      off();
      offCascade();
      clearInterval(sweep);
    };
  }, []);

  return {
    ids: snapshot.ids,
    blockerSeqFor: (issueId) => snapshot.map.get(issueId) ?? null,
  };
}
