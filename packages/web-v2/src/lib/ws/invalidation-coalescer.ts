import type { QueryClient } from "@tanstack/react-query";
import { noteInvalidated } from "@/lib/api/ref-bridge";
import { invalidateThroughInFlight } from "./invalidate-through-inflight";

export const INVALIDATE_WINDOW_MS = 250;

/**
 * The least time between two invalidations of one key. On a busy project a frame lands every second
 * or so, and every project-wide read on screen went again on each: the shell's counts and an issue
 * page's standing, forecast and run reads, 138 calls on one issue page (ISS-1070). A key that fired
 * inside this gap fires once at its end, so no frame is lost and a read goes at most once per gap.
 */
export const LIVE_MIN_GAP_MS = 5_000;

interface Window {
	clients: Set<QueryClient>;
	queryKey: readonly unknown[];
	timer: ReturnType<typeof setTimeout>;
}

const open = new Map<string, Window>();
/** When each key last fired, per client, so one client's gap never holds another's. */
const lastFired = new WeakMap<QueryClient, Map<string, number>>();

function fire(hash: string): void {
	const w = open.get(hash);
	if (!w) return;
	open.delete(hash);
	clearTimeout(w.timer);
	for (const qc of w.clients) {
		const fired = lastFired.get(qc) ?? new Map<string, number>();
		fired.set(hash, Date.now());
		lastFired.set(qc, fired);
		noteInvalidated(qc, w.queryKey);
		invalidateThroughInFlight(qc, { queryKey: w.queryKey });
	}
}

/** Invalidate `queryKey` once, at the end of the window its first event opened, and never sooner than the gap since it last fired. */
export function scheduleInvalidation(qc: QueryClient, queryKey: readonly unknown[]): void {
	const hash = JSON.stringify(queryKey);
	const existing = open.get(hash);
	if (existing) {
		existing.clients.add(qc);
		return;
	}
	const last = lastFired.get(qc)?.get(hash);
	const gapLeft = last === undefined ? 0 : last + LIVE_MIN_GAP_MS - Date.now();
	open.set(hash, {
		clients: new Set([qc]),
		queryKey,
		timer: setTimeout(() => fire(hash), Math.max(INVALIDATE_WINDOW_MS, gapLeft)),
	});
}
