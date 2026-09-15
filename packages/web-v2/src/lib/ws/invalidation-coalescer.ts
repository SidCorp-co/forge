"use client";

import type { QueryClient } from "@tanstack/react-query";
import { invalidateThroughInFlight } from "./invalidate-through-inflight";

/**
 * A fixed window between the socket and the query client.
 *
 * The deadline is set by the FIRST event of a window and later events inside it
 * do not push it back. A trailing timer reset on every event would be the other
 * reading and is the wrong one: under a continuing stream it never fires at all,
 * so a busy project's screen stops updating exactly when there is most to see.
 *
 * What 250 ms bounds is how long an invalidation waits to be DELIVERED. How long
 * the refetch then takes, whether it fails, and whether it waits on a first fetch
 * to settle are the query's; no bound on visible freshness is claimed here.
 */
export const INVALIDATE_WINDOW_MS = 250;

interface Window {
	// cm:guard a SET of clients, never one slot overwritten by the last schedule: two mounted consumers on different QueryClients that route the same key inside one window would otherwise leave the first one's screen stale, and `use-websocket.ts` states that multiple calls are safe.
	clients: Set<QueryClient>;
	queryKey: readonly unknown[];
	timer: ReturnType<typeof setTimeout>;
}

const open = new Map<string, Window>();

function fire(hash: string): void {
	const w = open.get(hash);
	if (!w) return;
	open.delete(hash);
	clearTimeout(w.timer);
	for (const qc of w.clients) invalidateThroughInFlight(qc, { queryKey: w.queryKey });
}

/** Invalidate `queryKey` once, at the end of the window its first event opened. */
export function scheduleInvalidation(qc: QueryClient, queryKey: readonly unknown[]): void {
	const hash = JSON.stringify(queryKey);
	const existing = open.get(hash);
	if (existing) {
		// cm:guard the timer is NOT restarted here — that is the whole difference between a fixed window and a trailing one, and the fixed one is what keeps a burst of any length from postponing its own refetch indefinitely.
		existing.clients.add(qc);
		return;
	}
	open.set(hash, {
		clients: new Set([qc]),
		queryKey,
		timer: setTimeout(() => fire(hash), INVALIDATE_WINDOW_MS),
	});
}

/** Close every open window now. The test seam; nothing in the app calls it. */
export function flushInvalidations(): void {
	for (const hash of [...open.keys()]) fire(hash);
}
