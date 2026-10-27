import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { couldNotRead, couldNotReadAll, pollUnlessRefused, refetchRefusedOnFocus, refusalStands } from "./read-failed";
import { markUnreachable, UNREACHABLE_SENTENCE } from "./transport-failure";

describe("a failed read says what and why (criterion 226)", () => {
	it("names the connection where the browser could not reach Forge, never the browser's words", () => {
		const err = new TypeError("Failed to fetch (forge-beta-api.sidcorp.co)");
		markUnreachable(err);
		const said = couldNotRead("The run", err);
		expect(said).toBe(`The run could not be read. ${UNREACHABLE_SENTENCE}`);
		expect(said).not.toMatch(/Failed to fetch/);
	});

	it("says the refusal's own sentence where Forge answered", () => {
		expect(couldNotRead("The cost", new ApiError(403, "Forbidden", "FORBIDDEN"))).toBe(
			"The cost could not be read. You do not have access to this resource.",
		);
	});
});

// ISS-1228 r25 (judge-81, criterion 248): two failed header reads were said in two places.
describe("several failed reads said in one sentence (criterion 248)", () => {
	it("names both before one reason where the reason is the same", () => {
		const refused = () => new ApiError(403, "Not a project member.", "FORBIDDEN");
		expect(
			couldNotReadAll([
				{ what: "The run", error: refused() },
				{ what: "Its session", error: refused() },
			]),
		).toBe("The run and its session could not be read. Not a project member.");
	});

	it("says each reason once where they differ, in the order the reads are named", () => {
		const lost = new TypeError("Failed to fetch");
		markUnreachable(lost);
		expect(
			couldNotReadAll([
				{ what: "The run", error: new ApiError(429, "Too many reads from this account. Try again in a minute.", "RATE_LIMITED") },
				{ what: "Its session", error: lost },
			]),
		).toBe(`The run could not be read. Too many reads from this account. Try again in a minute. Its session could not be read. ${UNREACHABLE_SENTENCE}`);
	});

	it("reads as couldNotRead for one read", () => {
		const err = new ApiError(404, "Project not found.", "NOT_FOUND");
		expect(couldNotReadAll([{ what: "The run", error: err }])).toBe(couldNotRead("The run", err));
	});
});

// ISS-1228 r25 (criteria 249 and 250): a refusal no retry changes was polled for ever.
describe("a refusal that stands", () => {
	const at = (error: unknown) => ({ state: { error } }) as Parameters<typeof refetchRefusedOnFocus>[0];

	it.each([400, 401, 403, 404, 410, 422])("stands for a %i", (status) => {
		expect(refusalStands(new ApiError(status, "No.", "X"))).toBe(true);
	});

	it.each([408, 409, 429, 500, 502, 503])("does not stand for a %i, which a retry can change", (status) => {
		expect(refusalStands(new ApiError(status, "Later.", "X"))).toBe(false);
	});

	it("does not stand for a lost connection or no failure", () => {
		const lost = new TypeError("Failed to fetch");
		markUnreachable(lost);
		expect(refusalStands(lost)).toBe(false);
		expect(refusalStands(null)).toBe(false);
	});

	it("stops the poll on a standing refusal and keeps it otherwise", () => {
		expect(pollUnlessRefused(at(new ApiError(403, "Not a project member.", "FORBIDDEN")), 20_000)).toBe(false);
		expect(pollUnlessRefused(at(new ApiError(503, "Restarting.", "UNAVAILABLE")), 20_000)).toBe(20_000);
		expect(pollUnlessRefused(at(null), 20_000)).toBe(20_000);
		expect(pollUnlessRefused(at(null), false)).toBe(false);
	});

	it("asks a standing refusal again on focus, whatever its age, and leaves the rest to the poll", () => {
		expect(refetchRefusedOnFocus(at(new ApiError(404, "Project not found.", "NOT_FOUND")))).toBe("always");
		expect(refetchRefusedOnFocus(at(null))).toBe(false);
	});
});
