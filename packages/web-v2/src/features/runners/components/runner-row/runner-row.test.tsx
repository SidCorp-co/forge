// ISS-276 / FB-87: the account printed "resets 2:30am (Asia/Ho_Chi_Minh)" (19:30Z), was refused at
// 16:02Z and answered at 16:42Z. The Runners screen says why and since when a runner is held and when
// it is tried again, names the printed time as the account's claim, and never counts down to it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatElapsed } from "@/lib/utils/format";
import type { ProjectRunner } from "../../types";
import { RunnerRow } from "./runner-row";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const NOW = Date.parse("2026-10-06T16:20:00Z");
const PRINTED = "2026-10-06T19:30:00Z";

const fb87Runner: ProjectRunner = {
	runnerId: "78ca8ff1-de53-493b-a64d-21940725eb5a",
	deviceId: "c04dcd83-e8e5-4a8e-8174-9bf31300bf60",
	deviceName: "sid-xeon-1-dev",
	platform: "linux",
	deviceStatus: "online",
	agentVersion: "0.4.0",
	deviceDisabledAt: null,
	runnerStatus: "online",
	lastError: "You've hit your session limit · resets 2:30am (Asia/Ho_Chi_Minh)",
	limitReason: "usage_limit",
	limitRefusedAt: "2026-10-06T16:02:00Z",
	rateLimitedUntil: "2026-10-06T16:23:00Z",
	limitPrintedResetAt: PRINTED,
	limitDetail: "You've hit your session limit · resets 2:30am (Asia/Ho_Chi_Minh)",
	repoPath: "/srv/checkout",
	branch: "dev",
	labels: [],
	lastSeenAt: "2026-10-06T16:19:58Z",
	provisionStatus: "ready",
	provisionDetail: null,
	provisionedAt: "2026-10-01T00:00:00Z",
	residentMaster: null,
	poolRead: null,
};

/** A countdown to the printed time ("resets in 3h", "resumes in 3h", "3h"), in the screen's own span words. */
const printedCountdown = new RegExp(`resets in|resumes (in|at)|\\b${formatElapsed(Date.parse(PRINTED) - NOW)}\\b`, "i");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function renderRow(runner: ProjectRunner) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<RunnerRow runner={runner} current={null} projectId="p1" canEdit={false} slug="forge" />
		</QueryClientProvider>,
	);
}

describe("the Runners screen row for a limited runner", () => {
	it("says why and since when it is held, and when it is tried again", () => {
		const { container } = renderRow(fb87Runner);
		expect(container).toHaveTextContent("Usage limit · refused 18m ago · next try in 3m");
	});

	it("names the printed time as what the account said, and never counts down to it", () => {
		const { container } = renderRow(fb87Runner);
		expect(screen.getByText(/The account said it resets at .+: its claim, not when work resumes\./)).toBeInTheDocument();
		expect(container.textContent).not.toMatch(printedCountdown);
	});

	it("speaks of no printed time where the account printed none", () => {
		const { container } = renderRow({ ...fb87Runner, limitPrintedResetAt: null });
		expect(container).toHaveTextContent("Usage limit · refused 18m ago · next try in 3m");
		expect(container.textContent).not.toMatch(/The account said it resets/);
	});
});
