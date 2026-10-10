"use client";

import { useState, useSyncExternalStore } from "react";

// One shared clock per interval, read with useSyncExternalStore: every component ticking at the
// same rate reads the same instant, and the clock runs only while someone is subscribed.
type Clock = { now: number; listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | null };
const clocks = new Map<number, Clock>();

function clockOf(intervalMs: number): Clock {
	let clock = clocks.get(intervalMs);
	if (!clock) {
		clock = { now: Date.now(), listeners: new Set(), timer: null };
		clocks.set(intervalMs, clock);
	}
	return clock;
}

function subscribe(intervalMs: number, listener: () => void): () => void {
	const clock = clockOf(intervalMs);
	if (clock.listeners.size === 0) {
		clock.now = Date.now();
		clock.timer = setInterval(() => {
			clock.now = Date.now();
			for (const l of clock.listeners) l();
		}, intervalMs);
	}
	clock.listeners.add(listener);
	return () => {
		clock.listeners.delete(listener);
		if (clock.listeners.size === 0 && clock.timer !== null) {
			clearInterval(clock.timer);
			clock.timer = null;
		}
	};
}

const idle = () => () => {};

/** The current time in ms, ticking every `intervalMs` while `active`; frozen at the last tick seen otherwise. */
export function useNow(intervalMs = 1000, active = true): number {
	const [mounted] = useState(() => Date.now());
	const clock = clockOf(intervalMs);
	const live = useSyncExternalStore(
		active ? (listener: () => void) => subscribe(intervalMs, listener) : idle,
		() => clock.now,
		() => clock.now,
	);
	return Math.max(mounted, live);
}
