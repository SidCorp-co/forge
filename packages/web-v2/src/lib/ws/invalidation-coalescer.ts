"use client";

import type { Query, QueryCache, QueryClient } from "@tanstack/react-query";
import { refusalStands } from "@/lib/api/read-failed";
import { invalidateThroughInFlight } from "./invalidate-through-inflight";

export const INVALIDATE_WINDOW_MS = 250;

/**
 * The least time between two starts of one read, by its key's first element (ISS-1228 r26): a tenth
 * over the two seconds promised, since a timer and the request it starts drift a few milliseconds.
 */
export const MIN_READ_GAP_MS: Readonly<Record<string, number>> = { "sessions-and-holds": 2_100 };

interface Window {
	clients: Set<QueryClient>;
	queryKey: readonly unknown[];
	/** Every event in the window was a check-in that moved nothing, which no refusal answers differently. */
	spareRefused: boolean;
	timer: ReturnType<typeof setTimeout>;
}

const open = new Map<string, Window>();

/** A query's latest start or failed attempt: a retry starts unannounced, its gap after a failure (ISS-1228 r27). */
const startedAt = new WeakMap<Query, number>();
const watched = new WeakSet<QueryCache>();
const ATTEMPT_ACTIONS: ReadonlySet<string> = new Set(["fetch", "failed", "error"]);

function watchStarts(qc: QueryClient): void {
	const cache = qc.getQueryCache();
	if (watched.has(cache)) return;
	watched.add(cache);
	cache.subscribe((event) => {
		if (event.type === "updated" && ATTEMPT_ACTIONS.has(event.action.type)) startedAt.set(event.query, Date.now());
	});
}

export function readGapOf(queryKey: readonly unknown[]): number {
	return MIN_READ_GAP_MS[String(queryKey[0])] ?? 0;
}

/** The earliest a read of `queryKey` may start again, from the latest start of any read it names. */
function notBefore(clients: Iterable<QueryClient>, queryKey: readonly unknown[]): number {
	const gap = readGapOf(queryKey);
	if (gap === 0) return 0;
	let latest = 0;
	for (const qc of clients) {
		for (const q of qc.getQueryCache().findAll({ queryKey: [...queryKey] })) {
			// A read that started before this client was watched is known only by when it ended, which is later.
			latest = Math.max(latest, startedAt.get(q) ?? Math.max(q.state.dataUpdatedAt, q.state.errorUpdatedAt));
		}
	}
	return latest === 0 ? 0 : latest + gap;
}

function filtersOf(w: Window) {
	return w.spareRefused
		? { queryKey: w.queryKey, predicate: (q: { state: { error: unknown } }) => !refusalStands(q.state.error) }
		: { queryKey: w.queryKey };
}

function fire(hash: string): void {
	const w = open.get(hash);
	if (!w) return;
	clearTimeout(w.timer);
	// A read started while the window was open (a poll, focus, Retry): the window waits out the gap from it.
	const wait = notBefore(w.clients, w.queryKey) - Date.now();
	if (wait > 0) {
		w.timer = setTimeout(() => fire(hash), wait);
		return;
	}
	open.delete(hash);
	for (const qc of w.clients) {
		// A re-read deferred behind a read in flight comes back through a window, so it keeps the gap too.
		invalidateThroughInFlight(qc, filtersOf(w), (queryKey, predicate) =>
			scheduleInvalidation(qc, queryKey, { spareRefused: predicate !== undefined }),
		);
	}
}

/**
 * Invalidate `queryKey` once, at the end of the window its first event opened, and no sooner than
 * its read's gap after the latest start of that read. `spareRefused` passes by a read Forge refused
 * for good (ISS-1228 r25): only when every event in the window asks it.
 */
export function scheduleInvalidation(
	qc: QueryClient,
	queryKey: readonly unknown[],
	{ spareRefused = false }: { spareRefused?: boolean } = {},
): void {
	watchStarts(qc);
	const hash = JSON.stringify(queryKey);
	const existing = open.get(hash);
	if (existing) {
		existing.clients.add(qc);
		existing.spareRefused &&= spareRefused;
		return;
	}
	const due = Math.max(INVALIDATE_WINDOW_MS, notBefore([qc], queryKey) - Date.now());
	open.set(hash, {
		clients: new Set([qc]),
		queryKey,
		spareRefused,
		timer: setTimeout(() => fire(hash), due),
	});
}

/** Close every open window now, gaps and all. The test seam; nothing in the app calls it. */
export function flushInvalidations(): void {
	for (const [hash, w] of [...open]) {
		clearTimeout(w.timer);
		open.delete(hash);
		for (const qc of w.clients) invalidateThroughInFlight(qc, filtersOf(w));
	}
}
