// @vitest-environment jsdom
//
// ISS-1359 repair 2. At 390px the device row's header (name, platform, version) printed over the
// Set primary / Re-provision / Unassign buttons, because a header and a button group that cannot
// wrap leave their overflow to paint on whatever is beside them. jsdom does no layout, so what this
// holds is the property the browser measurement rested on: the header wraps, the cluster of badges
// wraps inside it, and so does the group of buttons. The measurement is in the issue's record.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRunner } from "../types";

const mutation = () => ({ mutate: vi.fn(), isPending: false });
const query = <T,>(data: T) => ({ data, isLoading: false, isError: false });

const runner: ProjectRunner = {
	runnerId: "r-1",
	deviceId: "d-1",
	deviceName: "sid-xeon-1",
	platform: "linux",
	deviceStatus: "online",
	agentVersion: "0.17.111",
	deviceDisabledAt: null,
	runnerStatus: "idle",
	lastError: null,
	limitReason: null,
	rateLimitedUntil: null,
	limitDetail: null,
	repoPath: "/home/dev/forge/projects/anhome",
	branch: "main",
	labels: [],
	lastSeenAt: null,
	provisionStatus: "ready",
	provisionDetail: null,
	provisionedAt: "2026-10-09T00:00:00Z",
};

vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/projects/hooks", () => ({
	useProject: () => query({ id: "p-1", orgId: "o-1", defaultDeviceId: null, repoUrl: null }),
}));
vi.mock("@/features/project-settings/hooks", () => ({ useUpdateProject: mutation }));
vi.mock("@/features/resources/hooks", () => ({
	useOrgSshKeys: () => query([]),
	useCreateSshKey: mutation,
}));
// A hook this screen reads that is not named here answers an empty query that is also a no-op
// mutation, so what the test pins is the row and not every control around it.
const quiet = () => ({ ...mutation(), ...query(undefined) });
vi.mock("../hooks", () => ({
	useProjectRunners: () => query([runner]),
	useActiveRunners: () => query({ runners: [] }),
	useDevices: () => query([]),
	useAssignDeviceToProject: quiet,
	useClearRunnerError: quiet,
	useDeleteGitCredential: quiet,
	useGitCredential: quiet,
	useInitPairing: quiet,
	useReprovision: quiet,
	useRunnerActivity: quiet,
	useSetDefaultDevice: quiet,
	useSetRunnerAdmission: quiet,
	useSetRunnerLabels: quiet,
	useSetDeviceDisabled: quiet,
	useSetGitCredential: quiet,
	useTestGitCredential: quiet,
	useUnassignDeviceFromProject: quiet,
}));

const { ProjectRunnersScreen } = await import("./project-runners-screen");

afterEach(cleanup);

describe("the project Runners screen's device row at a narrow width", () => {
	it("lets the header, its badges and its buttons wrap rather than overprint", () => {
		render(<ProjectRunnersScreen projectId="p-1" canEdit embedded />);

		const header = screen.getByText("sid-xeon-1").parentElement?.parentElement;
		expect(header, "the row header").toBeTruthy();
		expect(header?.className).toContain("flex-wrap");
		expect(screen.getByText("sid-xeon-1").parentElement?.className).toContain("flex-wrap");
		const buttons = screen.getByRole("button", { name: /Re-provision/ }).parentElement;
		expect(buttons?.className).toContain("flex-wrap");
		expect(buttons?.contains(screen.getByRole("button", { name: /Unassign/ }))).toBe(true);
		expect(buttons?.contains(screen.getByRole("button", { name: /Set primary/ }))).toBe(true);
	});
});
