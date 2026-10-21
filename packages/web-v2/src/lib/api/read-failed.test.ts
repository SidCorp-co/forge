import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { couldNotRead, offersRetry } from "./read-failed";
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

describe("which failed read offers Retry (criteria 226 and 233)", () => {
	it("offers it for a refusal, a server failure and a lost connection", () => {
		const lost = new TypeError("Failed to fetch");
		markUnreachable(lost);
		expect(offersRetry(new ApiError(409, "Try again in a minute.", "HOLDS_READ_REFUSED"))).toBe(true);
		expect(offersRetry(new ApiError(404, "Not Found", "NOT_FOUND"))).toBe(true);
		expect(offersRetry(new ApiError(503, "Service Unavailable", "UNAVAILABLE"))).toBe(true);
		expect(offersRetry(lost)).toBe(true);
	});

	it("offers none for a 401, which signs the person out", () => {
		expect(offersRetry(new ApiError(401, "Unauthenticated", "UNAUTHENTICATED"))).toBe(false);
	});
});
