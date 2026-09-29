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
