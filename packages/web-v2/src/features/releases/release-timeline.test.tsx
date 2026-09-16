// @vitest-environment jsdom
//
// Criteria 41-44 of ISS-1042 are judged here.
//
// Every case below asserts a specific sentence or a specific field, never that
// "something rendered": the surface this replaces is a transcript on whichever
// box held the release, and a timeline that shows a generic card per act would
// be that transcript with worse typography. The two halves of an attempt — what
// the agent says and what Forge read — have separate authors, so the assertions
// keep them separate too.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleaseRunScreen } from "./components/release-run-screen";
import { ReleaseTimeline } from "./components/release-timeline";
import type { ReleaseAttempt, ReleaseRunState } from "./types";

expect.extend(matchers);
afterEach(cleanup);

function attempt(over: Partial<ReleaseAttempt> = {}): ReleaseAttempt {
	return {
		id: "a1",
		runId: "run-1",
		stage: "deploy",
		idempotencyKey: "deploy-1",
		commit: "abc1234def5678",
		providerRef: "coolify-dep-9f2",
		health: "up",
		identity: "abc1234def5678",
		verdict: "ok",
		verdictReason: null,
		readings: ["https://app/health -> 200"],
		account: "Deployed the merge commit and watched the container come up.",
		logTail: "…",
		logTailTruncated: false,
		logTailReadAt: null,
		logTailReadBy: null,
		startedAt: "2026-09-16T01:00:00.000Z",
		settledAt: "2026-09-16T01:04:00.000Z",
		...over,
	};
}

describe("ReleaseTimeline — 41: an ordered timeline whose body is the agent's account", () => {
	it("orders the entries oldest first whatever order they arrive in", () => {
		render(
			<ReleaseTimeline
				attempts={[
					attempt({ id: "c", idempotencyKey: "verify-1", startedAt: "2026-09-16T03:00:00.000Z" }),
					attempt({ id: "a", idempotencyKey: "promote-1", startedAt: "2026-09-16T01:00:00.000Z" }),
					attempt({ id: "b", idempotencyKey: "deploy-1", startedAt: "2026-09-16T02:00:00.000Z" }),
				]}
			/>,
		);
		const keys = screen
			.getAllByTestId("attempt-entry")
			.map((li) => within(li).getByText(/-1$/).textContent);
		expect(keys).toEqual(["promote-1", "deploy-1", "verify-1"]);
	});

	it("breaks a tie on id, the tie-break core's own listing uses", () => {
		const at = "2026-09-16T01:00:00.000Z";
		render(
			<ReleaseTimeline
				attempts={[
					attempt({ id: "b2", idempotencyKey: "second-1", startedAt: at }),
					attempt({ id: "a1", idempotencyKey: "first-1", startedAt: at }),
				]}
			/>,
		);
		const keys = screen
			.getAllByTestId("attempt-entry")
			.map((li) => within(li).getByText(/-1$/).textContent);
		expect(keys).toEqual(["first-1", "second-1"]);
	});

	it("puts the agent's own account in the entry body", () => {
		render(
			<ReleaseTimeline
				attempts={[attempt({ account: "Merged 6 branches, then held for the probe." })]}
			/>,
		);
		expect(screen.getByTestId("attempt-account")).toHaveTextContent(
			"Merged 6 branches, then held for the probe.",
		);
	});

	it("says the agent recorded no account rather than rendering an empty body", () => {
		render(<ReleaseTimeline attempts={[attempt({ account: null })]} />);
		expect(screen.getByTestId("attempt-account")).toHaveTextContent(
			"The agent recorded no account of this act.",
		);
	});
});

describe("ReleaseTimeline — 42: the machine's reading backs the account", () => {
	it("shows the commit, the provider reference, the health, the identity and the verdict", () => {
		render(
			<ReleaseTimeline
				attempts={[
					attempt({
						commit: "1234567890abcdef",
						providerRef: "coolify-dep-77",
						health: "down",
						identity: "fedcba0987654321",
						verdict: "failed",
					}),
				]}
			/>,
		);
		const backing = screen.getByTestId("attempt-backing");
		expect(backing).toHaveTextContent("Commit");
		expect(backing).toHaveTextContent("1234567890ab");
		expect(backing).toHaveTextContent("Provider reference");
		expect(backing).toHaveTextContent("coolify-dep-77");
		expect(backing).toHaveTextContent("Health");
		expect(backing).toHaveTextContent("down");
		expect(backing).toHaveTextContent("Identity");
		expect(backing).toHaveTextContent("fedcba098765");
		expect(backing).toHaveTextContent("Verdict");
		expect(backing).toHaveTextContent("failed");
	});

	it("names a reading the record does not hold instead of dropping its row", () => {
		render(
			<ReleaseTimeline
				attempts={[
					attempt({
						commit: null,
						providerRef: null,
						health: null,
						identity: null,
						verdict: null,
						readings: null,
					}),
				]}
			/>,
		);
		const backing = screen.getByTestId("attempt-backing");
		expect(backing).toHaveTextContent("Provider reference");
		expect(within(backing).getAllByText("not recorded")).toHaveLength(5);
	});

	it("keeps what the agent reported apart from what Forge read", () => {
		render(<ReleaseTimeline attempts={[attempt()]} />);
		const reported = screen.getByTestId("backing-reported");
		const read = screen.getByTestId("backing-read");
		// `providerRef` and `commit` reach the row through the agent's own routes —
		// `ledger.ts` refuses to let `settleAttempt` write either — so presenting
		// them as Forge's reading would put the agent's word back inside it.
		expect(reported).toHaveTextContent("Reported by the agent");
		expect(reported).toHaveTextContent("Commit");
		expect(reported).toHaveTextContent("Provider reference");
		expect(read).toHaveTextContent("Read by Forge");
		expect(read).toHaveTextContent("Health");
		expect(read).toHaveTextContent("Identity");
		expect(read).toHaveTextContent("Verdict");
		expect(read).not.toHaveTextContent("Provider reference");
		expect(reported).not.toHaveTextContent("Verdict");
	});

	it("separates an identity nobody checked from one the fleet did not agree on", () => {
		render(
			<ReleaseTimeline
				attempts={[
					attempt({
						identity: null,
						readings: ["https://a/health -> abc123", "https://b/health -> def456"],
						verdict: "failed",
					}),
				]}
			/>,
		);
		expect(screen.getByTestId("identity-unagreed")).toHaveTextContent(
			"no agreed identity",
		);
		const readings = screen.getByTestId("attempt-readings");
		expect(readings).toHaveTextContent("https://a/health -> abc123");
		expect(readings).toHaveTextContent("https://b/health -> def456");
	});

	it("says an identity was not recorded only where nothing was read at all", () => {
		render(<ReleaseTimeline attempts={[attempt({ identity: null, readings: null })]} />);
		expect(screen.queryByTestId("identity-unagreed")).toBeNull();
		expect(screen.queryByTestId("attempt-readings")).toBeNull();
		expect(screen.getByTestId("backing-read")).toHaveTextContent("not recorded");
	});

	it("keeps the agent's account and the machine's verdict as separate elements", () => {
		render(
			<ReleaseTimeline
				attempts={[attempt({ account: "It worked.", verdict: "failed" })]}
			/>,
		);
		expect(screen.getByTestId("attempt-account")).toHaveTextContent("It worked.");
		expect(screen.getByTestId("attempt-backing")).toHaveTextContent("failed");
		expect(screen.getByTestId("attempt-account")).not.toHaveTextContent("failed");
	});
});

describe("ReleaseTimeline — 43: a machine-cut log tail is marked read by nobody", () => {
	it("marks a cut tail nobody has read", () => {
		render(
			<ReleaseTimeline
				attempts={[attempt({ logTailTruncated: true, logTailReadAt: null })]}
			/>,
		);
		expect(screen.getByTestId("attempt-log-cut-unread")).toHaveTextContent(
			"Log cut short by the machine — read by nobody",
		);
	});

	it("does not call a cut tail unread once somebody has read past the cut", () => {
		render(
			<ReleaseTimeline
				attempts={[
					attempt({
						logTailTruncated: true,
						logTailReadAt: "2026-09-16T02:00:00.000Z",
						logTailReadBy: "u-1",
					}),
				]}
			/>,
		);
		expect(screen.queryByTestId("attempt-log-cut-unread")).toBeNull();
	});

	it("says nothing about a cut on a tail the machine did not cut", () => {
		render(
			<ReleaseTimeline
				attempts={[attempt({ logTailTruncated: false, logTailReadAt: null })]}
			/>,
		);
		expect(screen.queryByTestId("attempt-log-cut-unread")).toBeNull();
	});
});

describe("ReleaseTimeline — 44: an act that never reported is incomplete, not hidden", () => {
	it("renders an attempt whose act never reported back", () => {
		render(
			<ReleaseTimeline
				attempts={[
					attempt({ id: "a", idempotencyKey: "deploy-1", settledAt: "2026-09-16T01:04:00.000Z" }),
					attempt({ id: "b", idempotencyKey: "deploy-2", settledAt: null, startedAt: "2026-09-16T02:00:00.000Z" }),
				]}
			/>,
		);
		expect(screen.getAllByTestId("attempt-entry")).toHaveLength(2);
		expect(screen.getByTestId("attempt-incomplete")).toHaveTextContent(
			"Never reported",
		);
	});

	it("says the act is incomplete rather than finished", () => {
		render(<ReleaseTimeline attempts={[attempt({ settledAt: null })]} />);
		expect(screen.getByTestId("attempt-incomplete")).toHaveTextContent(
			"It is incomplete, not finished.",
		);
		expect(screen.getByTestId("attempt-entry")).toHaveAttribute(
			"data-incomplete",
			"true",
		);
	});

	it("marks a settled attempt complete", () => {
		render(<ReleaseTimeline attempts={[attempt()]} />);
		expect(screen.queryByTestId("attempt-incomplete")).toBeNull();
		expect(screen.getByTestId("attempt-entry")).toHaveAttribute(
			"data-incomplete",
			"false",
		);
	});

	it("says the run recorded no acts rather than rendering an empty list", () => {
		render(<ReleaseTimeline attempts={[]} />);
		expect(screen.queryByTestId("release-timeline")).toBeNull();
		expect(screen.getByText("This run has recorded no acts")).toBeInTheDocument();
	});
});

const query = vi.fn();
vi.mock("./hooks", async () => {
	const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
	return { ...actual, useReleaseRunState: () => query() };
});

const STATE: ReleaseRunState = {
	runId: "run-1",
	projectId: "p1",
	runStatus: "running",
	roster: {
		gateStatus: "awaiting_release",
		channel: "prod",
		releaseRunnerLabel: "release",
		baseBranch: "main",
		nextCutAt: null,
		issues: [
			{
				id: "i1",
				displayId: "ISS-1",
				title: "A thing that shipped",
				mergedAt: "2026-09-15T00:00:00.000Z",
				waitingDays: 1,
				claimedByRunId: "run-1",
			},
		],
	},
	attempts: [attempt()],
	live: {
		health: "up",
		identity: "abc1234def5678",
		readings: ["https://app/health -> 200"],
		unhealthy: [],
		unidentified: [],
		disagreement: null,
	},
	bounds: { holding: false, crossedNames: [], bounds: [] },
	method: {
		skill: "release-flow",
		loaded: true,
		detail: null,
		announcedAt: "2026-09-16T00:50:00.000Z",
	},
	methodUnloaded: false,
};

function mockQuery(over: Record<string, unknown> = {}) {
	query.mockReturnValue({
		data: STATE,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
		isFetching: false,
		dataUpdatedAt: Date.now(),
		...over,
	});
}

describe("ReleaseRunScreen — 41: the surface that shows the timeline", () => {
	it("renders the run's timeline on the screen itself", () => {
		mockQuery();
		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);
		expect(screen.getByTestId("release-timeline")).toBeInTheDocument();
		expect(screen.getByTestId("attempt-account")).toHaveTextContent(
			"Deployed the merge commit and watched the container come up.",
		);
		expect(screen.getByTestId("live-read-at")).toHaveTextContent("read just now");
	});

	// `staleTime: 0` starts a refetch; it does not withhold the cached answer
	// while that refetch is in flight. A page that says "read just now" because
	// it rendered would show a person coming back to a tab the reading from
	// before the outage they came back to look at.
	it("does not call an hour-old cached reading one taken just now", () => {
		mockQuery({ isFetching: true, dataUpdatedAt: Date.now() - 3_600_000 });
		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);
		const at = screen.getByTestId("live-read-at");
		expect(at).not.toHaveTextContent("read just now");
		expect(at).toHaveTextContent("reading now");
		expect(at).toHaveTextContent("3600s ago");
	});

	it("dates a settled reading that is no longer fresh instead of calling it now", () => {
		mockQuery({ isFetching: false, dataUpdatedAt: Date.now() - 120_000 });
		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);
		const at = screen.getByTestId("live-read-at");
		expect(at).not.toHaveTextContent("read just now");
		expect(at).toHaveTextContent("read 120s ago");
	});

	it("renders a retryable error rather than an empty page", () => {
		mockQuery({ data: undefined, isError: true, error: new Error("boom") });
		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);
		expect(screen.getByText("Couldn't load this release run")).toBeInTheDocument();
	});
});
