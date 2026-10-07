// ISS-276 / FB-87: a refused pass reads "refused at T, next try at the next nudge", and the first pass
// that ran after refusals says it is the recovery.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MasterClosedPass } from "../types";
import { lastPassText } from "./master-views";

const base: MasterClosedPass = {
	id: "p1",
	sessionId: "s1",
	verb: "dispatch",
	startedAt: "2026-10-06T16:02:00Z",
	endedAt: "2026-10-06T16:03:00Z",
	issueKey: null,
	trigger: "nudge",
	dispatched: [],
	skipped: [],
	parked: [],
	refused: null,
	recovers: null,
	closeReason: "turn_ended",
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-06T16:12:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("lastPassText", () => {
	it("reads a refused pass as refused when, next try at the next nudge, with no printed time", () => {
		const text = lastPassText({
			lastPass: { ...base, refused: { reason: "usage_limit", detail: "You've hit your session limit · resets 2:30am (Asia/Ho_Chi_Minh)" } },
		});
		expect(text).toBe("Last pass refused 10m ago (usage limit), next try at the next nudge");
	});

	it("marks the pass that ran after refusals as the recovery", () => {
		const text = lastPassText({
			lastPass: {
				...base,
				startedAt: "2026-10-06T16:10:00Z",
				endedAt: "2026-10-06T16:11:00Z",
				dispatched: ["ISS-253"],
				recovers: { refusedSince: "2026-10-06T16:02:00Z", refusedPasses: 4, reason: "usage_limit" },
			},
		});
		expect(text).toBe("Last pass 1m ago: dispatched 1, skipped 0, the account answered again after 4 refused passes since 10m ago");
	});

	it("says nothing of a recovery on a pass that was not one", () => {
		expect(lastPassText({ lastPass: { ...base, dispatched: ["ISS-1"] } })).toBe("Last pass 9m ago: dispatched 1, skipped 0");
	});
});
