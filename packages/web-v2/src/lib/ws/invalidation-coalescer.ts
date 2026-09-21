"use client";

import type { QueryClient } from "@tanstack/react-query";
import { invalidateThroughInFlight } from "./invalidate-through-inflight";

export const INVALIDATE_WINDOW_MS = 250;

interface Window {
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
