// ISS-276 / FB-87: the account printed "resets 2:30am (Asia/Ho_Chi_Minh)" (19:30Z), was refused at
// 16:02Z and answered at 16:42Z. The dashboard card says why and since when a runner is held, as the
// Runners screen does, names the printed time as the account's claim, and never counts down to it.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRunner } from "@/features/runners/types";
import { formatElapsed } from "@/lib/utils/format";
import { runnersSummary } from "../derive";
import { RunnersCard } from "./runners-card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const NOW = Date.parse("2026-10-06T16:20:00Z");
const PRINTED = "2026-10-06T19:30:00Z";

const limited = {
	runnerId: "78ca8ff1-de53-493b-a64d-21940725eb5a",
	deviceId: "c04dcd83-e8e5-4a8e-8174-9bf31300bf60",
	deviceName: "sid-xeon-1-dev",
	platform: "linux",
	deviceStatus: "online",
	runnerStatus: "online",
	limitReason: "usage_limit",
	limitRefusedAt: "2026-10-06T16:02:00Z",
	rateLimitedUntil: "2026-10-06T16:23:00Z",
	limitPrintedResetAt: PRINTED,
	limitDetail: "You've hit your session limit · resets 2:30am (Asia/Ho_Chi_Minh)",
} as ProjectRunner;

/** A countdown to the printed time ("resets in 3h", "resumes in 3h", "3h"), in the card's own span words. */
const printedCountdown = new RegExp(`resets in|resumes (in|at)|\\b${formatElapsed(Date.parse(PRINTED) - NOW)}\\b`, "i");

const card = (runner: ProjectRunner) =>
	render(<RunnersCard summary={runnersSummary([runner], undefined, NOW)} slug="forge" />);

describe("the dashboard Runners card for a limited runner", () => {
	it("says why and since when it is held, and when it is tried again, as the Runners screen does", () => {
		const { getByTestId } = card(limited);
		expect(getByTestId("runner-line")).toHaveTextContent("Usage limit · refused 18m ago · next try in 3m");
	});

	it("names the printed time as what the account said, and never counts down to it", () => {
		const { getByTestId } = card(limited);
		const line = getByTestId("runner-line");
		expect(line).toHaveTextContent(/The account said it resets at .+: its claim, not when work resumes\./);
		expect(line.textContent).not.toMatch(printedCountdown);
	});

	it("speaks of no printed time where the account printed none", () => {
		const { getByTestId } = card({ ...limited, limitPrintedResetAt: null });
		expect(getByTestId("runner-line").textContent).not.toMatch(/The account said it resets/);
	});
});
