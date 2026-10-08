// @vitest-environment jsdom
//
// Per-file jsdom opt-in — see the docblock on
// project-dashboard/awaiting-release-card.test.tsx for why the shared config
// stays `environment: 'node'`.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseRunState } from "../types";
import { ReleaseRunScreen } from "./release-run-screen";

expect.extend(matchers);

const runState = vi.fn();
vi.mock("../hooks", () => ({
	useReleaseRunState: () => runState(),
}));

function state(over: Partial<ReleaseRunState>) {
	runState.mockReturnValue({
		data: {
			runId: "run-1",
			projectId: "p1",
			runStatus: "running",
			roster: {
				gateStatus: "releasing",
				channels: ["coolify"],
				releaseRunnerLabel: null,
				baseBranch: "main",
				nextCutAt: null,
				issues: [],
			},
			attempts: [],
			live: null,
			verification: null,
			bounds: { holding: true, crossedNames: [], bounds: [] },
			method: null,
			methodUnloaded: false,
			start: { kind: "taken", at: "2026-09-26T11:59:00.000Z", device: "box-1" },
			runIssues: [],
			...over,
		} satisfies ReleaseRunState,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
		isFetching: false,
		dataUpdatedAt: Date.parse("2026-09-26T12:00:00.000Z"),
	});
}

beforeEach(() => {
	runState.mockReset();
});
afterEach(cleanup);

describe("the method line", () => {
	// ISS-1276 deleted the gate that refused `finish` for a run that announced
	// nothing, and criterion 19 is that such a run now finishes. This sentence
	// is what an operator watching that run reads, and believing it costs an
	// abort of a healthy release.
	it("does not tell an operator that a run with no announcement cannot be finished", () => {
		state({ method: null });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const line = screen.getByTestId("method-line");
		expect(line).toHaveTextContent("No method announced");
		expect(line.textContent).not.toMatch(/cannot be finished/i);
		expect(line.textContent).toMatch(/can still be finished/i);
	});

	it("names the deploy refusal an announcement actually stands in front of", () => {
		state({ method: null });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		expect(screen.getByTestId("method-line").textContent).toMatch(
			/deploy through Forge, which is refused until this run has recorded something/i,
		);
	});

	it("shows the skill and a loaded badge once a run has announced one", () => {
		state({
			method: {
				skill: "release-flow",
				loaded: true,
				detail: null,
				announcedAt: "2026-09-26T12:00:00.000Z",
			},
			methodUnloaded: false,
		});

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const line = screen.getByTestId("method-line");
		expect(line).toHaveTextContent("release-flow");
		expect(line).toHaveTextContent("loaded");
		expect(line.textContent).not.toMatch(/No method announced/i);
	});

	it("says a method would not load without saying the run is stuck", () => {
		state({
			method: {
				skill: "release-flow",
				loaded: false,
				detail: "the skill did not resolve on this box",
				announcedAt: "2026-09-26T12:00:00.000Z",
			},
			methodUnloaded: true,
		});

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const line = screen.getByTestId("method-line");
		expect(line).toHaveTextContent("could not load");
		expect(line).toHaveTextContent("the skill did not resolve on this box");
		expect(line.textContent).not.toMatch(/cannot be finished/i);
	});
});

// ISS-1322, routed from ISS-1321's judge: a batch with no probe runs and closes unverified, and
// this card said a batch could not be created without one.
describe("production, for a release no probe reads", () => {
	it("says the release will close unverified, not that it could not be created", () => {
		state({ live: null, verification: "unverified" });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const card = screen.getByTestId("live-none");
		expect(card.textContent).toMatch(/close unverified/i);
		expect(card.textContent).not.toMatch(/can no longer be created/i);
	});

	it("does not call a release unverified when the run recorded no verification", () => {
		state({ live: null, verification: null });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const card = screen.getByTestId("live-none");
		expect(card.textContent).not.toMatch(/unverified/i);
		expect(card.textContent).not.toMatch(/can no longer be created/i);
	});
});

// ISS-1322's judge saw "will close unverified" beside a `completed` chip: the tense is the run's.
describe("the unverified close, in the tense of the run's own status", () => {
	it.each(["running", "paused"])("a %s run is told the release will close unverified", (runStatus) => {
		state({ live: null, verification: "unverified", runStatus });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		expect(screen.getByTestId("live-none").textContent).toMatch(/will close unverified/i);
	});

	it("a completed run is told the release closed unverified", () => {
		state({ live: null, verification: "unverified", runStatus: "completed" });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const card = screen.getByTestId("live-none").textContent ?? "";
		expect(card).toMatch(/closed unverified/i);
		expect(card).not.toMatch(/will close/i);
	});

	it.each(["failed", "cancelled"])("a %s run is told nothing about how the release closes", (runStatus) => {
		state({ live: null, verification: "unverified", runStatus });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const card = screen.getByTestId("live-none").textContent ?? "";
		expect(card).toMatch(/no verification probe/i);
		expect(card).not.toMatch(/close/i);
	});
});

describe("the start line (ISS-1323)", () => {
	it("says no box has started a waiting release, why, and when it is handed back", () => {
		state({
			start: {
				kind: "waiting",
				since: "2026-09-26T11:50:00.000Z",
				handedBackAt: "2026-09-26T12:20:00.000Z",
				reason: "no-eligible-box",
				why: "`box-1` is `draining` and so takes nothing from the pool.",
			},
		});

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const line = screen.getByTestId("start-line");
		expect(line).toHaveTextContent("No box has started this release");
		expect(line).toHaveTextContent("box-1 is draining");
		expect(line).toHaveTextContent("handed back at");
		expect(line.querySelector('time[datetime="2026-09-26T12:20:00.000Z"]')).not.toBeNull();
	});

	it("says a handed-back release went back to the gate, without the waiting copy", () => {
		state({ start: { kind: "handed-back", at: "2026-09-26T12:20:00.000Z", why: "no box took it." } });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const line = screen.getByTestId("start-line");
		expect(line).toHaveTextContent("Handed back to the release gate");
		expect(line).toHaveTextContent("no box took it.");
		expect(line.textContent).not.toMatch(/handed back at|No box has started/);
	});

	it("says a release whose job ended unstarted never started", () => {
		state({ start: { kind: "ended", status: "failed", at: null, why: "its job ended `failed`." } });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		expect(screen.getByTestId("start-line")).toHaveTextContent("This release never started");
	});

	it("says plainly when the run holds no release job", () => {
		state({ start: { kind: "none", why: "no box was ever asked to start it." } });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const line = screen.getByTestId("start-line");
		expect(line).toHaveTextContent("This run holds no release job");
		expect(line.textContent).not.toMatch(/handed back at/);
	});

	it("prints nothing once a box has taken the job", () => {
		state({});

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		expect(screen.queryByTestId("start-line")).not.toBeInTheDocument();
	});
});

describe("an empty timeline, in the tense of the run's own status", () => {
	it("a completed run with no acts says it took none, not that it has not started one", () => {
		state({ runStatus: "completed", attempts: [] });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		expect(screen.getByText(/before it ended/)).toBeInTheDocument();
		expect(screen.queryByText(/has not started one/)).not.toBeInTheDocument();
	});

	it("a running run with no acts says it has not started one yet", () => {
		state({ runStatus: "running", attempts: [] });

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		expect(screen.getByText(/has not started one/)).toBeInTheDocument();
	});
});

// ISS-1323 r2 — the judge's findings at a89a4f1 (comment 894d3e50) and the owner's flat-UI rule.
describe("the run screen, read by the person who pressed (ISS-1323 r2)", () => {
	it("shows the start line's code as code, with no backtick left", () => {
		state({
			start: {
				kind: "waiting",
				since: "2026-09-26T11:50:00.000Z",
				handedBackAt: "2026-09-26T12:20:00.000Z",
				reason: "eligible-not-taken",
				why: "`judge-box` can run it and has not picked it up yet.",
			},
		});

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const line = screen.getByTestId("start-line");
		expect(line.textContent).not.toContain("`");
		expect(line.querySelector("code")?.textContent).toBe("judge-box");
	});

	it("prints its times in local time with how long ago and how long until, not raw UTC", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-26T12:00:00.000Z"));
		try {
			state({
				start: {
					kind: "waiting",
					since: "2026-09-26T11:50:00.000Z",
					handedBackAt: "2026-09-26T12:20:00.000Z",
					reason: "eligible-not-taken",
					why: "No box has picked it up yet.",
				},
			});

			render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

			const line = screen.getByTestId("start-line").textContent ?? "";
			expect(line).not.toContain("2026-09-26T");
			expect(line).toContain("10m ago");
			expect(line).toContain("in 20 min");
			expect(line).toContain(new Date("2026-09-26T12:20:00.000Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
		} finally {
			vi.useRealTimers();
		}
	});

	it("says never started once for a handed-back release", () => {
		state({
			runStatus: "cancelled",
			start: {
				kind: "handed-back",
				at: "2026-09-26T12:20:00.000Z",
				why: "Handed back because no box took this release batch before its deadline, so it never started.",
			},
		});

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const line = screen.getByTestId("start-line").textContent ?? "";
		expect(line.match(/never started/gi) ?? []).toHaveLength(1);
	});

	it("says a batch aborted before any box took it was aborted, by whom and why", () => {
		state({
			runStatus: "cancelled",
			start: {
				kind: "aborted",
				at: "2026-09-26T12:05:00.000Z",
				by: "Ana Lima",
				why: "wrong roster",
			},
		});

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const line = screen.getByTestId("start-line");
		expect(line).toHaveTextContent("Aborted before it started");
		expect(line).toHaveTextContent("Ana Lima");
		expect(line).toHaveTextContent("wrong roster");
	});

	it("says no method was announced because the release never started", () => {
		state({
			runStatus: "cancelled",
			start: { kind: "ended", status: "cancelled", at: null, why: "It ended before any box took it." },
		});

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const method = screen.getByTestId("method-line").textContent ?? "";
		expect(method).toMatch(/never started/);
		expect(method).not.toMatch(/can still be finished/);
	});

	it("lists the issues the run was opened with, not those at the gate now", () => {
		state({
			roster: {
				gateStatus: "awaiting_release",
				channels: [],
				releaseRunnerLabel: null,
				baseBranch: "main",
				nextCutAt: null,
				issues: [{ id: "g-5", displayId: "ISS-5", title: "At the gate now", mergedAt: null, waitingDays: null, claimedByRunId: null, closeRefusals: [], closeFailure: null }],
			} as ReleaseRunState["roster"],
			runIssues: [{ id: "r-1", displayId: "ISS-1", title: "Opened with the run", status: "releasing" }],
		});

		render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		const roster = screen.getByTestId("roster");
		expect(roster).toHaveTextContent("ISS-1");
		expect(roster).toHaveTextContent("Opened with the run");
		expect(roster).not.toHaveTextContent("ISS-5");
	});

	it("lays its sections out flat, with no card surface", () => {
		state({});

		const { container } = render(<ReleaseRunScreen projectId="p1" runId="run-1" />);

		expect(container.querySelector(".shadow-sm")).toBeNull();
		expect(container.querySelector(".rounded-lg.border")).toBeNull();
	});
});
