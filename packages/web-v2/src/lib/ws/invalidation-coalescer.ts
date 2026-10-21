"use client";

import type { QueryClient } from "@tanstack/react-query";
import { refusalStands } from "@/lib/api/read-failed";
import { invalidateThroughInFlight } from "./invalidate-through-inflight";

export const INVALIDATE_WINDOW_MS = 250;

interface Window {
	clients: Set<QueryClient>;
	queryKey: readonly unknown[];
	/** Every event in the window was a check-in that moved nothing, which no refusal answers differently. */
	spareRefused: boolean;
	timer: ReturnType<typeof setTimeout>;
}

const open = new Map<string, Window>();

function fire(hash: string): void {
	const w = open.get(hash);
	if (!w) return;
	open.delete(hash);
	clearTimeout(w.timer);
	const filters = w.spareRefused
		? { queryKey: w.queryKey, predicate: (q: { state: { error: unknown } }) => !refusalStands(q.state.error) }
		: { queryKey: w.queryKey };
	for (const qc of w.clients) invalidateThroughInFlight(qc, filters);
}

/**
 * Invalidate `queryKey` once, at the end of the window its first event opened. `spareRefused` passes
 * by a read Forge refused for good (ISS-1228 r25): only when every event in the window asks it.
 */
export function scheduleInvalidation(
	qc: QueryClient,
	queryKey: readonly unknown[],
	{ spareRefused = false }: { spareRefused?: boolean } = {},
): void {
	const hash = JSON.stringify(queryKey);
	const existing = open.get(hash);
	if (existing) {
		existing.clients.add(qc);
		existing.spareRefused &&= spareRefused;
		return;
	}
	open.set(hash, {
		clients: new Set([qc]),
		queryKey,
		spareRefused,
		timer: setTimeout(() => fire(hash), INVALIDATE_WINDOW_MS),
	});
}

/** Close every open window now. The test seam; nothing in the app calls it. */
export function flushInvalidations(): void {
	for (const hash of [...open.keys()]) fire(hash);
}
