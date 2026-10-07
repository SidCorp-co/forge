// ISS-276 / FB-87: the account printed "resets 2:30am (Asia/Ho_Chi_Minh)" (19:30Z) and answered at
// 16:42Z. A limited runner reads when it was refused and when it is tried again; the printed time is
// named as the account's claim and never shown as when work resumes.

import { describe, expect, it } from "vitest";
import { type ProjectRunner, runnerLimitDisplay, runnerLimitLine } from "./types";

const now = Date.parse("2026-10-06T16:20:00Z");
type LimitFields = Pick<ProjectRunner, "limitReason" | "rateLimitedUntil" | "limitDetail" | "limitRefusedAt" | "limitPrintedResetAt">;
const refused: LimitFields = {
	limitReason: "usage_limit",
	limitRefusedAt: "2026-10-06T16:02:00Z",
	rateLimitedUntil: "2026-10-06T16:23:00Z",
	limitPrintedResetAt: "2026-10-06T19:30:00Z",
	limitDetail: "You've hit your session limit · resets 2:30am (Asia/Ho_Chi_Minh)",
};

describe("runnerLimitDisplay", () => {
	it("reads refused when and next try when, and never a reset countdown to the printed time", () => {
		const limit = runnerLimitDisplay(refused, now);
		expect(limit).toMatchObject({ active: true, refusedText: "refused 18m ago", nextTryText: "next try in 3m" });
		const line = limit ? runnerLimitLine(limit) : "";
		expect(line).toBe("Usage limit · refused 18m ago · next try in 3m");
		expect(JSON.stringify(limit)).not.toMatch(/resets in/);
	});

	it("names the printed time as what the account said, not as when work resumes", () => {
		expect(runnerLimitDisplay(refused, now)?.printedText).toMatch(/^The account said it resets at .+: its claim, not when work resumes\.$/);
		expect(runnerLimitDisplay({ ...refused, limitPrintedResetAt: null }, now)?.printedText).toBeNull();
	});

	it("says the next try is due once it has come, and the runner is no longer held", () => {
		const due = runnerLimitDisplay(refused, Date.parse("2026-10-06T16:24:00Z"));
		expect(due).toMatchObject({ active: false, nextTryText: "next try due" });
	});

	it("holds an auth failure with no next try", () => {
		const auth = runnerLimitDisplay({ ...refused, limitReason: "auth", rateLimitedUntil: null, limitPrintedResetAt: null }, now);
		expect(auth).toMatchObject({ active: true, nextTryText: null, health: "down" });
	});

	it("reads a limit stamped before core kept the refusal time without inventing one", () => {
		const old = runnerLimitDisplay({ ...refused, limitRefusedAt: undefined, limitPrintedResetAt: undefined }, now);
		expect(old).toMatchObject({ refusedText: null, printedText: null, nextTryText: "next try in 3m" });
	});
});
