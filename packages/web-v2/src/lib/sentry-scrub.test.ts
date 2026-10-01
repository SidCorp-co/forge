import { FILTERED, SCRUB_BODY_KEYS, scrubSentryEvent } from "@forge/observability";
import { describe, expect, it } from "vitest";

// A retired key leaves the scrubber never: an old client, a log line or a replay still sends it.
const RETIRED = "testCredentials";

describe("the scrubber filters a key the product no longer writes", () => {
	it(`keeps ${RETIRED} in SCRUB_BODY_KEYS`, () => {
		expect(SCRUB_BODY_KEYS.has(RETIRED)).toBe(true);
	});

	it("filters it in an object body", () => {
		const event = scrubSentryEvent({
			request: { data: { [RETIRED]: { username: "ops@acme", password: "x" }, note: "kept" } },
		});
		expect(event.request?.data).toEqual({ [RETIRED]: FILTERED, note: "kept" });
	});

	it("filters it in a JSON string body, nested", () => {
		const event = scrubSentryEvent({
			request: { data: JSON.stringify({ env: { [RETIRED]: [{ password: "x" }] } }) },
		});
		expect(JSON.parse(event.request?.data as string)).toEqual({
			env: { [RETIRED]: FILTERED },
		});
	});

	it("filters it in breadcrumb data", () => {
		const event = scrubSentryEvent({
			breadcrumbs: [{ data: { [RETIRED]: { password: "x" } } }],
		});
		expect(event.breadcrumbs?.[0]?.data).toEqual({ [RETIRED]: FILTERED });
	});
});
