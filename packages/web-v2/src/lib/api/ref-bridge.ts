"use client";

import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_RE.test(value);

/** What one key segment becomes once its reference is resolved, or `undefined` where it is not that reference. */
export type Rekey = (segment: unknown) => unknown;

/**
 * The key segment an issue's own reads are cached under: its uuid, or, while a page holds only the
 * display key off its URL, the key with the project it is scoped by (a display key alone collides
 * across projects). The page switches to the uuid once the issue answers (`useBridgedRef`).
 */
export function issueKeySegment(id: string | undefined, projectId: string | undefined): unknown {
  return !id || UUID_RE.test(id) ? id : { issue: id, project: projectId ?? null };
}

/** The provisional segment {@link issueKeySegment} wrote for `key` in `projectId`, renamed to the issue's uuid. */
export function issueRekey(key: string, projectId: string | undefined, uuid: string): Rekey {
  return (segment) => {
    if (typeof segment !== "object" || segment === null) return undefined;
    const s = segment as { issue?: unknown; project?: unknown };
    return s.issue === key && s.project === (projectId ?? null) ? uuid : undefined;
  };
}

function rekeyed(key: QueryKey, rekey: Rekey): QueryKey | null {
  for (let i = 0; i < key.length; i++) {
    const to = rekey(key[i]);
    if (to !== undefined) return [...key.slice(0, i), to, ...key.slice(i + 1)];
  }
  return null;
}

/** How long an invalidation that found no read is remembered for a read bridged to its key later. */
export const MISSED_INVALIDATION_MS = 60_000;

const missed = new WeakMap<QueryClient, { key: QueryKey; at: number }[]>();

/**
 * A live change named a uuid before the page had switched to it: the reads it meant were still
 * cached under the slug or display key, so the invalidation reached none of them. Remembered, so
 * {@link bridgeQueries} re-reads what it hands over from that span instead of serving it as fresh.
 */
export function noteInvalidated(qc: QueryClient, key: QueryKey, at = Date.now()): void {
  const kept = (missed.get(qc) ?? []).filter((m) => at - m.at < MISSED_INVALIDATION_MS);
  kept.push({ key, at });
  missed.set(qc, kept);
}

function invalidatedSince(qc: QueryClient, key: QueryKey, since: number): boolean {
  return (missed.get(qc) ?? []).some(
    (m) => m.at >= since && m.key.length <= key.length && m.key.every((seg, i) => JSON.stringify(seg) === JSON.stringify(key[i])),
  );
}

/**
 * Hands every cached read whose key names a provisional reference to the same key under the
 * resolved one: its answer where it has one, the fetch still in flight where it has not. A read
 * already cached under the resolved key keeps its own. A read that failed is left to refetch, and
 * one a live change named while it sat under the provisional key is read again.
 */
export function bridgeQueries(qc: QueryClient, rekey: Rekey, now = Date.now()): number {
  const cache = qc.getQueryCache();
  let bridged = 0;
  for (const query of cache.getAll()) {
    const twin = rekeyed(query.queryKey, rekey);
    if (!twin || cache.find({ queryKey: twin, exact: true })) continue;
    const { data, dataUpdatedAt, status, fetchStatus } = query.state;
    const inFlight = query.promise;
    const changed = invalidatedSince(qc, twin, now - MISSED_INVALIDATION_MS);
    if (status === "success") {
      qc.setQueryData(twin, data, { updatedAt: dataUpdatedAt });
      if (changed) void qc.invalidateQueries({ queryKey: twin, exact: true });
    } else if (fetchStatus === "fetching" && inFlight && !changed) {
      void qc.prefetchQuery({ queryKey: twin, queryFn: () => inFlight, retry: false });
    } else {
      continue;
    }
    bridged++;
  }
  return bridged;
}

/**
 * The reference a page's reads key and address something by: `provisional` (what its URL said)
 * until `resolved` is known. On the switch, every read already sent under the provisional reference
 * is handed to the resolved one first ({@link bridgeQueries}), so nothing is sent twice; where the
 * resolved reference was known before any read went out, the provisional one is never used.
 */
export function useBridgedRef(
  provisional: string | undefined,
  resolved: string | undefined,
  rekeyFor: (provisional: string, resolved: string) => Rekey,
): string | undefined {
  const qc = useQueryClient();
  const usedProvisional = useRef(new Set<string>());
  const [bridged, setBridged] = useState<string | null>(null);
  if (provisional && resolved === undefined) usedProvisional.current.add(provisional);
  const pair = provisional && resolved ? `${provisional}\u0000${resolved}` : null;
  const owed = pair !== null && usedProvisional.current.has(provisional as string) && bridged !== pair;
  const rekey = useRef(rekeyFor);
  rekey.current = rekeyFor;

  useEffect(() => {
    if (!owed || !pair || !provisional || !resolved) return;
    bridgeQueries(qc, rekey.current(provisional, resolved));
    setBridged(pair);
  }, [owed, pair, provisional, resolved, qc]);

  if (resolved === undefined) return provisional;
  return owed ? provisional : resolved;
}
