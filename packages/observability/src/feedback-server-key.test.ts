// A product server's feedback key (ISS-922) files feedback into a project as that product: it is
// redacted by its prefix wherever it turns up, a header line or cut off, and text that only mentions
// the prefix in passing is kept.
// @direct-test-of packages/observability/src/index.ts

import { describe, expect, it } from "vitest";
import { containsSecret, scrubLogText } from "./index.js";

const key = `fsk_${"Ab9_-".repeat(8)}xyz`;

describe("a feedback server key", () => {
	it.each([
		["in a header line", `authorization: Bearer ${key}`],
		["in an env line", `FORGE_FEEDBACK_KEY=${key}`],
		["cut off", `key ${key.slice(0, 16)}`],
	])("is redacted %s", (_where, text) => {
		expect(scrubLogText(text)).not.toContain(key.slice(4, 16));
		expect(containsSecret(text)).toBe(true);
	});

	it("keeps text that names the prefix alone", () => {
		const text = "a server key starts fsk_ and is shown once";
		expect(scrubLogText(text)).toBe(text);
	});
});
