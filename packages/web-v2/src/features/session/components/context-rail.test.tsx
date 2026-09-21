// @vitest-environment jsdom
//
// ISS-1119 — the session context rail is the fourth surface that renders a
// runner's version, and it is the one an independent judge could not witness on
// the beta deployment: a master session's rail shows the short device id because
// the signed-in account does not own that box, so the branch that renders a
// version never runs for that viewer. The rendered branch is exercised here
// instead, with the device in the viewer's own list.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "@/features/sessions/types";

const useDevices = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/runners/hooks", () => ({ useDevices }));
vi.mock("@/features/sessions/hooks", () => ({
	useSessionCost: () => ({ data: undefined }),
	useSessions: () => ({ data: { items: [] } }),
}));

const { ContextRail } = await import("./context-rail");

afterEach(() => {
	cleanup();
	useDevices.mockReset();
});

const DEVICE_ID = "6f6a3b5d-0c2e-4f1a-9d33-6b2c9a8e1f04";

const session = {
	id: "s1",
	projectId: "p1",
	deviceId: DEVICE_ID,
	status: "completed",
	startedAt: "2026-09-21T09:00:00.000Z",
	updatedAt: "2026-09-21T09:05:00.000Z",
	usage: {},
	metadata: {},
	repoPath: "/home/dev/forge/projects/forge-core",
} as unknown as SessionRow;

function device(agentVersion: string | null) {
	return { id: DEVICE_ID, name: "sid-xeon-1", platform: "linux", status: "online", agentVersion };
}

describe("the runner version on the session context rail", () => {
	it("shows the version that device reported", () => {
		useDevices.mockReturnValue({ data: [device("0.17.0")] });

		render(<ContextRail session={session} items={[]} />);

		expect(screen.getByText(/Linux · v0\.17\.0/)).toBeTruthy();
	});

	it("says a version was not reported rather than rendering an empty string", () => {
		useDevices.mockReturnValue({ data: [device(null)] });

		render(<ContextRail session={session} items={[]} />);

		expect(screen.getByText(/Linux · version not reported/)).toBeTruthy();
	});

	it("substitutes no other number for a version the device never reported", () => {
		useDevices.mockReturnValue({ data: [device(null)] });

		const { container } = render(<ContextRail session={session} items={[]} />);

		const runnerSection = container.textContent ?? "";
		expect(runnerSection).not.toContain("v0.17.0");
		expect(runnerSection).not.toContain("v0.3.0");
	});

	it("shows the short device id, and no version at all, for a box the viewer does not own", () => {
		useDevices.mockReturnValue({ data: [] });

		render(<ContextRail session={session} items={[]} />);

		expect(screen.getByText(DEVICE_ID.slice(0, 8))).toBeTruthy();
		expect(screen.queryByText(/version not reported/)).toBeNull();
		expect(screen.queryByText(/Linux/)).toBeNull();
	});
});
