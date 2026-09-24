// @vitest-environment jsdom
//
// ISS-1192 criterion 18: a box opens its run with its gate condition, and a
// reviewer reads that run on the session screen, not on the issue board.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunGate } from "@/features/pipeline/types";
import type { SessionRow } from "@/features/sessions/types";

const useRun = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/runners/hooks", () => ({ useDevices: () => ({ data: [] }) }));
vi.mock("@/features/pipeline/hooks", () => ({ useRun }));
vi.mock("@/features/sessions/hooks", () => ({
	useSessionCost: () => ({ data: undefined }),
	useSessions: () => ({ data: { items: [] } }),
}));

const { ContextRail } = await import("./context-rail");

afterEach(() => {
	cleanup();
	useRun.mockReset();
});

const RUN_ID = "257e1927-ac6f-4af2-a970-0920070bf4b6";

function session(kind: string): SessionRow {
	return {
		id: "s1",
		projectId: "p1",
		deviceId: null,
		pipelineRunId: RUN_ID,
		kind,
		status: "running",
		startedAt: "2026-09-24T23:43:00.000Z",
		updatedAt: "2026-09-24T23:44:00.000Z",
		usage: {},
		metadata: {},
		repoPath: null,
	} as unknown as SessionRow;
}

const failingOpen: RunGate = {
	read: "ok",
	condition: {
		verdict: "failing_open",
		count: 295,
		perDay: 70.6,
		windowMs: 361_038_987,
		byReason: [
			{ reason: "FORGE_CONTROL_TOKEN is unset", count: 14 },
			{ reason: "this pane carries no control capability, so nothing could be asked", count: 281 },
		],
	},
};

function withGate(gateAtOpen: RunGate | null) {
	useRun.mockReturnValue({ data: { gateAtOpen } });
}

function railText(kind: string): string {
	const { container } = render(<ContextRail session={session(kind)} items={[]} />);
	const text = container.textContent ?? "";
	cleanup();
	return text;
}

describe("the gate a run session opened under, on the session rail", () => {
	it("says the gate was failing open, with the count, the rate, the window and the reason's share", () => {
		withGate(failingOpen);
		render(<ContextRail session={session("run_session")} items={[]} />);

		expect(screen.getByText("Declaration gate")).toBeTruthy();
		expect(screen.getByText(/gate was failing open when this run opened/)).toBeTruthy();
		expect(screen.getByText(/^295 dispatch\(es\) admitted without a decision, 71\/day over 100h 17m$/)).toBeTruthy();
		expect(screen.getByText(/^281 of 295: this pane carries no control capability/)).toBeTruthy();
		expect(useRun).toHaveBeenCalledWith(RUN_ID, true);
	});

	it("tells a box that sent no condition apart from a gate that was deciding", () => {
		withGate(null);
		const none = railText("run_session");
		withGate({ read: "ok", condition: { verdict: "clear", count: 0, perDay: null, windowMs: null, byReason: [] } });
		const clear = railText("run_session");

		expect(none).toContain("The box reported no gate condition when this run opened");
		expect(none).not.toContain("gate was deciding when");
		expect(clear).toContain("gate was deciding when this run opened");
		expect(clear).not.toContain("reported no gate condition");
	});

	it("says a stored condition could not be read", () => {
		withGate({ read: "unreadable", reason: "gate.verdict: bad enum" });
		render(<ContextRail session={session("run_session")} items={[]} />);

		expect(screen.getByText(/cannot be read/)).toBeTruthy();
		expect(screen.getByText(/gate\.verdict: bad enum/)).toBeTruthy();
	});

	it("shows no gate section for a pipeline session, whose run the box never opened", () => {
		withGate(null);
		render(<ContextRail session={session("pipeline")} items={[]} />);

		expect(screen.queryByText("Declaration gate")).toBeNull();
		expect(useRun).toHaveBeenCalledWith(RUN_ID, false);
	});
});
