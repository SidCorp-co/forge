import { describe, expect, it } from "vitest";
import {
	channelsFor,
	NOTIFICATION_TYPES,
	notificationContractOf,
} from "./notifications.js";

// ISS-1192 (FB-603, `notify-only-to-act`): a log-tier kind is activity. Its records are the item's
// history and the project's activity, and they reach nobody's bell or toast: a tier said and not
// obeyed put 52% activity on one account's bell.
describe("the notification contract", () => {
	const logTier = NOTIFICATION_TYPES.filter(
		(t) => notificationContractOf(t).tier === "log",
	);

	it("declares no surface for a log-tier kind", () => {
		const loud = logTier
			.map((t) => [t, notificationContractOf(t).channels] as const)
			.filter(([, channels]) => channels.length > 0);
		expect(loud, "a log-tier kind declaring a surface").toEqual([]);
	});

	it("keeps the step changes of a requirement and a feedback item off every surface", () => {
		expect(notificationContractOf("requirement_step").tier).toBe("log");
		expect(channelsFor("requirement_step")).toEqual([]);
		expect(notificationContractOf("feedback_step").tier).toBe("log");
		expect(channelsFor("feedback_step")).toEqual([]);
	});

	it("keeps a person's word to a reporter on the bell, as a ticket", () => {
		expect(notificationContractOf("feedback_message")).toMatchObject({
			kind: "signal",
			tier: "ticket",
		});
		expect(channelsFor("feedback_message")).toContain("bell");
	});
});
