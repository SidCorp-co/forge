import type { Query } from "@tanstack/react-query";
import { ApiError } from "./client";
import { formatApiError } from "./error";

export function couldNotRead(what: string, error: unknown): string {
	return `${what} could not be read. ${formatApiError(error)}`;
}

/** Several failed reads in one sentence, each reason said once, in the order named (ISS-1228 r25). */
export function couldNotReadAll(reads: ReadonlyArray<{ what: string; error: unknown }>): string {
	const byWhy = new Map<string, string[]>();
	for (const { what, error } of reads) {
		const why = formatApiError(error);
		byWhy.set(why, [...(byWhy.get(why) ?? []), what]);
	}
	return [...byWhy]
		.map(([why, whats]) => {
			const named = whats.map((w, i) => (i === 0 ? w : w.charAt(0).toLowerCase() + w.slice(1)));
			const subject = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
			return `${subject} could not be read. ${why}`;
		})
		.join(" ");
}

export function clockAt(at: number | string | null | undefined): string | null {
	if (at === null || at === undefined || at === "" || at === 0) return null;
	const when = new Date(at);
	if (Number.isNaN(when.getTime())) return null;
	return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
}

/** A reading kept through a failed refresh, marked with when it was read: "Running · as of 14:02" (ISS-1228 r26). */
export function asOf(label: string, readAt: number | string): string {
	const at = clockAt(readAt);
	return at ? `${label} · as of ${at}` : label;
}

export function couldNotRefresh(readAt: number | string, error: unknown): string {
	return `Could not refresh — showing what was read at ${clockAt(readAt) ?? readAt}. ${formatApiError(error)}`;
}

export function heldThroughFailure(q: { isError: boolean; data: unknown }): boolean {
	return q.isError && q.data !== undefined;
}

/** A project's own read answered 404: the project is gone, or hidden from this caller, for the whole page (ISS-1228 r26). */
export function projectGone(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}

/** Every failed read offers Retry but a 401's, which signs the person out (ISS-1228). */
export function offersRetry(error: unknown): boolean {
	return !(error instanceof ApiError && error.status === 401);
}

const STANDING_REFUSALS = new Set([400, 401, 403, 404, 410, 422]);

/** Forge refused this read for a reason another identical request cannot change (ISS-1228 r25). */
export function refusalStands(error: unknown): boolean {
	return error instanceof ApiError && STANDING_REFUSALS.has(error.status);
}

type LiveQuery = Pick<Query, "state">;

/** A live poll that stops on a standing refusal, read again on Retry, focus or a frame naming a change. */
export function pollUnlessRefused(query: LiveQuery, ms: number | false): number | false {
	return refusalStands(query.state.error) ? false : ms;
}

/** The person coming back to the tab is the moment a standing refusal is asked again. */
export function refetchRefusedOnFocus(query: LiveQuery): boolean | "always" {
	return refusalStands(query.state.error) ? "always" : false;
}
