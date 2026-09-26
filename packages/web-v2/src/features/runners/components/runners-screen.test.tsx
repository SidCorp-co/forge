// @vitest-environment jsdom
//
// ISS-1162 criteria 9 to 20. Measured on forge-beta 2026-09-21: this page said
// "No devices yet" to an admin while the same account's Overview said 40
// runners. What is read here is what the page CLAIMS — which population it is
// showing, what it counts, and what it says when a list is empty or a query has
// not answered.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRow, OrgDeviceRow } from "../types";

const listDevices = vi.fn(async (): Promise<DeviceRow[]> => []);
const listOrgDevices = vi.fn(async (): Promise<OrgDeviceRow[]> => []);
vi.mock("../api", () => ({ runnersApi: { listDevices, listOrgDevices, initPairing: vi.fn() } }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-1" } }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
let activeOrgId: string | null = "org-1";
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrgId }) }));

const { RunnersScreen } = await import("./runners-screen");
const { ORG_DEVICES_REFRESH_MS } = await import("../hooks");

function device(over: Partial<DeviceRow> = {}): DeviceRow {
	return {
		id: "dev-1",
		name: "my-laptop",
		platform: "linux",
		agentVersion: "0.17.1",
		agentCommit: null,
		latestAgentVersion: null,
		latestAgentCommit: null,
		mainRunnerHead: null,
		agentBuildState: "current",
		runnerReleaseState: "current",
		agentBuildDetail: "",
		agentOutdated: false,
		ownedByMe: true,
		status: "online",
		disabledAt: null,
		lastSeenAt: null,
		pairedAt: null,
		capabilities: null,
		gate: null,
		gitCredentialRef: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		...over,
	};
}

function orgDevice(over: Partial<OrgDeviceRow> = {}): OrgDeviceRow {
	const { capabilities: _c, gate: _g, ...rest } = device({
		id: "dev-2",
		name: "sid-xeon-1",
		ownedByMe: false,
	});
	return { ...rest, runnerCount: 2, projectNames: ["Pipeline Alpha", "Pipeline Beta"], ...over };
}

function Wrap({ children }: { children: ReactNode }) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Both lists are read on mount, so a render is not settled until both answered. */
async function show() {
	render(<RunnersScreen />, { wrapper: Wrap });
	await screen.findByRole("button", { name: /^Mine · / });
	await screen.findByRole("button", { name: /^Organisation · / });
}

const tab = (name: RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
	activeOrgId = "org-1";
	listDevices.mockResolvedValue([]);
	listOrgDevices.mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("the scope control", () => {
	it("shows both populations and both counts at once, each counted as devices", async () => {
		listDevices.mockResolvedValue([device()]);
		listOrgDevices.mockResolvedValue([orgDevice(), orgDevice({ id: "dev-3" })]);

		await show();

		expect(tab(/^Mine · 1 device$/)).toBeTruthy();
		expect(tab(/^Organisation · 2 devices$/)).toBeTruthy();
	});

	it("reads a count it does not have yet as not-yet-counted, never as zero", async () => {
		listDevices.mockResolvedValue([device()]);
		listOrgDevices.mockImplementation(() => new Promise(() => []));

		render(<RunnersScreen />, { wrapper: Wrap });
		await screen.findByRole("button", { name: /^Mine · 1 device$/ });

		expect(tab(/^Organisation · counting…$/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Organisation · 0 devices/ })).toBeNull();
	});
});

describe("the own scope", () => {
	it("names its population as the caller's own, unassigned boxes included", async () => {
		listDevices.mockResolvedValue([device()]);

		await show();

		expect(screen.getByText(/Every device you have paired/)).toBeTruthy();
		expect(screen.getByText("my-laptop")).toBeTruthy();
	});

	it("keeps the owner's controls, which the org list does not carry", async () => {
		listDevices.mockResolvedValue([device()]);

		await show();

		expect(screen.getByRole("button", { name: "Manage" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
	});

	it("lists the owner's devices whatever project they serve, the call carrying no org filter", async () => {
		listDevices.mockResolvedValue([device({ name: "just-paired" })]);

		await show();

		expect(screen.getByText("just-paired")).toBeTruthy();
		expect(listDevices).toHaveBeenCalledWith(undefined);
	});

	it("says the organisation's count rather than 'No devices yet' when it is empty", async () => {
		listOrgDevices.mockResolvedValue([orgDevice(), orgDevice({ id: "dev-3" })]);

		await show();

		expect(screen.getByText("You have not paired any machines")).toBeTruthy();
		expect(screen.getByText(/Your organisation runs 2 devices/)).toBeTruthy();
		expect(screen.queryByText("No devices yet")).toBeNull();
	});
});

describe("the organisation scope", () => {
	it("lists a device another member paired, and says on the row that it is theirs", async () => {
		listOrgDevices.mockResolvedValue([orgDevice()]);

		await show();
		tab(/^Organisation · /).click();

		expect(await screen.findByText("sid-xeon-1")).toBeTruthy();
		expect(screen.getByText("paired by another member")).toBeTruthy();
	});

	it("offers no Turn off, no Revoke and no Manage on a row this caller did not pair", async () => {
		listOrgDevices.mockResolvedValue([orgDevice()]);

		await show();
		tab(/^Organisation · /).click();
		await screen.findByText("sid-xeon-1");

		expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
		expect(screen.getByText("read only")).toBeTruthy();
	});

	it("points a caller at Mine for a box of their own standing in the org list", async () => {
		listOrgDevices.mockResolvedValue([orgDevice({ id: "dev-9", ownedByMe: true })]);

		await show();
		tab(/^Organisation · /).click();
		await screen.findByText("sid-xeon-1");

		expect(screen.getByText("yours — manage it under Mine")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
	});

	it("names every project in the organisation the device serves", async () => {
		listOrgDevices.mockResolvedValue([orgDevice()]);

		await show();
		tab(/^Organisation · /).click();

		expect(await screen.findByText("Serves Pipeline Alpha, Pipeline Beta")).toBeTruthy();
	});

	it("reconciles its device count with the runner count Overview reports", async () => {
		listOrgDevices.mockResolvedValue([orgDevice()]);

		await show();
		tab(/^Organisation · /).click();

		expect(
			await screen.findByText(/This 1 device serves 2 runner assignments between them/),
		).toBeTruthy();
		expect(screen.getByText(/Overview counts as runners/)).toBeTruthy();
	});

	it("never claims the organisation whole when it is empty, only what this caller can see", async () => {
		listDevices.mockResolvedValue([device()]);

		await show();
		tab(/^Organisation · /).click();

		expect(
			await screen.findByText(
				"No device is assigned to a project you can see in this organisation",
			),
		).toBeTruthy();
		expect(screen.getByText(/You have paired 1 device/)).toBeTruthy();
	});
});

describe("a scope whose query has not answered", () => {
	it("claims no population while the active org is still being resolved", async () => {
		activeOrgId = null;
		listDevices.mockResolvedValue([device()]);

		render(<RunnersScreen />, { wrapper: Wrap });
		await screen.findByRole("button", { name: /^Mine · 1 device$/ });
		tab(/^Organisation · /).click();
		// The scope really is on screen before anything is read off it: a click
		// React has not flushed would leave every assertion below unfalsifiable.
		await screen.findByText(/Every device assigned to a project you can see/);

		expect(
			screen.queryByText("No device is assigned to a project you can see in this organisation"),
		).toBeNull();
		expect(listOrgDevices).not.toHaveBeenCalled();
		expect(tab(/^Organisation · counting…$/)).toBeTruthy();
	});
});

describe("the organisation list, which no event about another member's box reaches", () => {
	it("drops a device another member revoked without an event, on its own refresh", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			listDevices.mockResolvedValue([]);
			listOrgDevices.mockResolvedValue([orgDevice()]);

			render(<RunnersScreen />, { wrapper: Wrap });
			await screen.findByRole("button", { name: /^Organisation · 1 device$/ });
			tab(/^Organisation · /).click();
			await screen.findByText("sid-xeon-1");

			listOrgDevices.mockResolvedValue([]);
			await vi.advanceTimersByTimeAsync(ORG_DEVICES_REFRESH_MS + 1_000);

			expect(screen.queryByText("sid-xeon-1")).toBeNull();
			expect(tab(/^Organisation · 0 devices$/)).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a list that failed to load", () => {
	it("reports the failure with a retry rather than an empty population", async () => {
		listDevices.mockResolvedValue([device()]);
		listOrgDevices.mockRejectedValue(new Error("gateway said no"));

		render(<RunnersScreen />, { wrapper: Wrap });
		await screen.findByRole("button", { name: /^Mine · 1 device$/ });
		tab(/^Organisation · /).click();

		expect(await screen.findByRole("button", { name: /retry/i })).toBeTruthy();
		expect(
			screen.queryByText("No device is assigned to a project you can see in this organisation"),
		).toBeNull();
	});
});
