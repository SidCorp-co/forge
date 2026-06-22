"use client";

import { useEffect, useState } from "react";

/**
 * A live-ticking clock. Returns `Date.now()`, re-rendering every `intervalMs`
 * (default 1s) so callers can re-derive time-relative labels — e.g. a runner
 * limit countdown via `runnerLimitDisplay(runner, now)` — without refetching.
 *
 * Pass `active=false` to freeze (no interval) when nothing on screen needs to
 * tick, e.g. when no runner is currently limited.
 */
export function useNow(intervalMs = 1000, active = true): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs, active]);

	return now;
}
