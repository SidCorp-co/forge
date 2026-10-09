import { describe, expect, it } from "vitest";
import { whatsNewSeenValueSchema } from "./product-state.js";

const AT = "2026-10-09T11:00:00Z";

describe("whatsNewSeenValueSchema", () => {
	it("keeps a mark from before What's new read releases", () => {
		expect(whatsNewSeenValueSchema.safeParse({ at: AT }).success).toBe(true);
	});

	it("keeps the release a person saw, in the environment that served it", () => {
		const parsed = whatsNewSeenValueSchema.safeParse({
			at: AT,
			release: { environment: "dev", version: "0.4.0-dev.9", at: AT },
		});
		expect(parsed.success).toBe(true);
	});

	it("refuses a release with no environment, an empty version, or a field it does not hold", () => {
		for (const release of [
			{ version: "0.4.0", at: AT },
			{ environment: "dev", version: " ", at: AT },
			{ environment: "dev", version: "0.4.0", at: AT, project: "x" },
		]) {
			expect(
				whatsNewSeenValueSchema.safeParse({ at: AT, release }).success,
			).toBe(false);
		}
	});
});
