import type { Query } from "@tanstack/react-query";
import { ApiError } from "./client";
import { formatApiError } from "./error";

export function couldNotRead(what: string, error: unknown): string {
	return `${what} could not be read. ${formatApiError(error)}`;
}

/**
 * Several failed reads said in one sentence: "The run and its session could not be read. <why>",
 * each reason once, in the order the reads are named (ISS-1228 r25).
 */
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

/** Every failed read offers Retry but a 401's, which signs the person out (ISS-1228). */
export function offersRetry(error: unknown): boolean {
	return !(error instanceof ApiError && error.status === 401);
}

/** Refusals a retry meets again unchanged: no request, membership or project moves by being asked twice. */
const STANDING_REFUSALS = new Set([400, 401, 403, 404, 410, 422]);

/** Forge refused this read for a reason another identical request cannot change (ISS-1228 r25). */
export function refusalStands(error: unknown): boolean {
	return error instanceof ApiError && STANDING_REFUSALS.has(error.status);
}

type LiveQuery = Pick<Query, "state">;

/**
 * A live read's poll that stops on a standing refusal: polling it only repeats the refusal. It is
 * read again on Retry, on focus ({@link refetchRefusedOnFocus}) and on a frame naming a change.
 */
export function pollUnlessRefused<Q extends LiveQuery>(ms: number | ((query: Q) => number | false)) {
	return (query: Q): number | false =>
		refusalStands(query.state.error) ? false : typeof ms === "number" ? ms : ms(query);
}

/** The person coming back to the tab is the moment a standing refusal is asked again. */
export function refetchRefusedOnFocus(query: LiveQuery): boolean | "always" {
	return refusalStands(query.state.error) ? "always" : false;
}
