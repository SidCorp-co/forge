import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { couldNotRead } from "./read-failed";
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
