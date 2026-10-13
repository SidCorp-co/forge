// @vitest-environment jsdom
//
// ISS-1262: the Pipeline page is ONE form with ONE save bar. What is asserted is what the page puts
// on the wire and what it says, read back through the server's own contract: the store below runs
// the same `@forge/contracts/document-patch` functions `updatePipelineConfig` calls, so a body the
// real route would refuse is refused here too.

import {
	applyDocumentPatch,
	comparePatchBase,
	describeConflicts,
} from "@forge/contracts/document-patch";
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaveGuardProvider } from "@/design";
import { ApiError } from "@/lib/api/client";
import { PipelineTab } from "./components/pipeline-tab";

expect.extend(matchers);

type Doc = Record<string, unknown>;
type Plugin = { marketplace: string; name: string; pinnedRef: string | null; autoUpdate: boolean };

let stored: Doc;
let plugins: Plugin[];
/** Every pipeline-config body the page sent, and every plugins list, in order. */
let configWrites: Array<{ base: Doc; patch: Doc }>;
let pluginWrites: Plugin[][];
let pluginsFail: boolean;
/** The runners the project answers for. */
let runners: Array<{ deviceId: string; deviceName: string; deviceStatus: string; runnerStatus: string }>;

vi.mock("@/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
	return {
		...actual,
		apiClient: async (path: string, init?: { method?: string; body?: string }) => {
			if (path.endsWith("/pipeline-config") && init?.method === "PATCH") {
				const write = JSON.parse(init.body ?? "null") as { base: Doc; patch: Doc };
				configWrites.push(write);
				const conflicts = comparePatchBase(stored, write.base, write.patch);
				if (conflicts.length > 0) {
					throw new ApiError(
						409,
						`the pipeline config changed since you read it — ${describeConflicts(conflicts)}. Nothing was written.`,
						"CONFIG_STALE",
						{ conflicts },
					);
				}
				stored = applyDocumentPatch(stored, write.patch);
				return { pipelineConfig: structuredClone(stored) };
			}
			if (path.endsWith("/pipeline-config")) return { pipelineConfig: structuredClone(stored) };
			if (path.endsWith("/plugins") && init?.method === "PATCH") {
				const body = JSON.parse(init.body ?? "{}") as { plugins: Plugin[] };
				pluginWrites.push(body.plugins);
				if (pluginsFail) throw new ApiError(500, "the plugins store is down", "SERVER_ERROR");
				plugins = body.plugins;
				return { plugins };
			}
			if (path === "/projects/p1") return { id: "p1", agentConfig: { plugins: structuredClone(plugins) } };
			throw new Error(`unmocked ${init?.method ?? "GET"} ${path}`);
		},
	};
});

vi.mock("./hooks", async (importActual) => {
	const actual = await importActual<typeof import("./hooks")>();
	return { ...actual, useReleaseReadiness: () => ({ isLoading: true, isError: false }) };
});

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

vi.mock("@/features/runners/hooks", () => ({
	useProjectRunners: () => ({
		data: runners,
		isPending: false,
	}),
}));

const START: Doc = {
	enabled: true,
	states: { open: { enabled: true, mode: "auto" }, in_progress: { enabled: true, mode: "auto" } },
	intakeGate: { enabled: false },
	knowledgePromotion: { enabled: true, candidatesPerRun: 3, minRetrievals: 2 },
};
const PLUGIN: Plugin = {
	marketplace: "SidCorp-co/forge-plugin",
	name: "forge",
	pinnedRef: null,
	autoUpdate: false,
};

function mountPage() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<LeaveGuardProvider>
				<PipelineTab projectId="p1" canEdit slug="forge" />
			</LeaveGuardProvider>
		</QueryClientProvider>,
	);
}

const ready = () => screen.findByRole("switch", { name: "Pipeline enabled" });
const saveButton = () => screen.getByRole("button", { name: "Save" });
const toggle = (name: string) => fireEvent.click(screen.getByRole("switch", { name }));
const type = (label: string | RegExp, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = () => fireEvent.click(saveButton());

beforeEach(() => {
	stored = structuredClone(START);
	plugins = [{ ...PLUGIN }];
	configWrites = [];
	pluginWrites = [];
	pluginsFail = false;
	runners = [
		{ deviceId: "box-a", deviceName: "box-a", deviceStatus: "online", runnerStatus: "online" },
		{ deviceId: "box-b", deviceName: "box-b", deviceStatus: "online", runnerStatus: "online" },
	];
	toast.mockClear();
});
afterEach(cleanup);

describe("one form, one save bar", () => {
	it("offers exactly one Save, and no section carries one of its own", async () => {
		mountPage();
		await ready();
		const saves = screen.getAllByRole("button").filter((b) => /^save/i.test(b.textContent ?? ""));
		expect(saves).toHaveLength(1);
		expect(saves[0]).toHaveTextContent(/^Save$/);
	});

	it("keeps Save disabled until a value moves, and disables it again when the edit is put back", async () => {
		mountPage();
		await ready();
		expect(saveButton()).toBeDisabled();
		toggle("Notify the project owner on each gated issue");
		expect(saveButton()).toBeDisabled();
		toggle("Require human approval for new issues");
		expect(saveButton()).toBeEnabled();
		toggle("Require human approval for new issues");
		expect(saveButton()).toBeDisabled();
	});

	it("puts the draft back when the person discards it", async () => {
		mountPage();
		await ready();
		toggle("Require human approval for new issues");
		fireEvent.click(screen.getByRole("button", { name: "Discard" }));
		await waitFor(() =>
			expect(screen.getByRole("switch", { name: "Require human approval for new issues" })).toHaveAttribute(
				"aria-checked",
				"false",
			),
		);
		expect(saveButton()).toBeDisabled();
	});
});

describe("what one Save writes", () => {
	it("is one pipeline-config write naming only the leaves that moved, with no plugins write", async () => {
		mountPage();
		await ready();
		toggle("Require human approval for new issues");
		type("Minimum retrievals before a memory is eligible", "7");
		press();

		await waitFor(() => expect(configWrites).toHaveLength(1));
		expect(configWrites[0]?.patch).toEqual({
			intakeGate: { enabled: true },
			knowledgePromotion: { minRetrievals: 7 },
		});
		expect(pluginWrites).toEqual([]);
		expect(stored.states).toEqual(START.states);
		expect(stored.enabled).toBe(true);
	});

	it("does not collide with another writer who moved a path this page never edited", async () => {
		mountPage();
		await ready();
		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-b"] } } });
		toggle("Require human approval for new issues");
		press();

		await waitFor(() => expect(configWrites).toHaveLength(1));
		expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
		expect((stored.intakeGate as Doc).enabled).toBe(true);
		expect(((stored.states as Doc).open as Doc).deviceIds).toEqual(["box-b"]);
	});

	it("takes the plugins in the same Save, config first", async () => {
		mountPage();
		await ready();
		toggle("Require human approval for new issues");
		fireEvent.click(screen.getByRole("button", { name: "Add a plugin" }));
		const rows = screen.getAllByLabelText("Marketplace");
		fireEvent.change(rows[1] as HTMLElement, { target: { value: "acme/market" } });
		fireEvent.change(screen.getAllByLabelText("Name")[1] as HTMLElement, { target: { value: "acme" } });
		press();

		await waitFor(() => expect(pluginWrites).toHaveLength(1));
		expect(configWrites).toHaveLength(1);
		expect(pluginWrites[0]).toEqual([
			PLUGIN,
			{ marketplace: "acme/market", name: "acme", pinnedRef: null, autoUpdate: false },
		]);
	});

	it("sends no plugins write when the pipeline-config write is refused", async () => {
		mountPage();
		await ready();
		toggle("Require human approval for new issues");
		fireEvent.click(screen.getByRole("button", { name: "Add a plugin" }));
		fireEvent.change(screen.getAllByLabelText("Marketplace")[1] as HTMLElement, {
			target: { value: "acme/market" },
		});
		fireEvent.change(screen.getAllByLabelText("Name")[1] as HTMLElement, { target: { value: "acme" } });
		stored = applyDocumentPatch(stored, { intakeGate: { enabled: true, notify: false } });
		press();

		await screen.findByText(/changed by someone else/i);
		expect(pluginWrites).toEqual([]);
		expect(plugins).toEqual([PLUGIN]);
	});
});

describe("a Save that lands in part", () => {
	async function editBoth() {
		mountPage();
		await ready();
		toggle("Require human approval for new issues");
		fireEvent.click(screen.getByRole("button", { name: "Add a plugin" }));
		fireEvent.change(screen.getAllByLabelText("Marketplace")[1] as HTMLElement, {
			target: { value: "acme/market" },
		});
		fireEvent.change(screen.getAllByLabelText("Name")[1] as HTMLElement, { target: { value: "acme" } });
	}

	it("says what was saved and what was not", async () => {
		pluginsFail = true;
		await editBoth();
		press();

		const banner = await screen.findByText(/the pipeline settings were saved, but the plugins were not/i);
		expect(banner.textContent).toMatch(/the plugins store is down/);
		expect((stored.intakeGate as Doc).enabled).toBe(true);
	});

	it("reads the saved fields as clean, keeps the plugin edit, and a retry sends the plugins alone", async () => {
		pluginsFail = true;
		await editBoth();
		press();
		await screen.findByText(/the plugins were not/i);
		await waitFor(() => expect(saveButton()).toBeEnabled());
		expect(screen.getAllByLabelText("Marketplace")).toHaveLength(2);
		expect(screen.getByRole("switch", { name: "Require human approval for new issues" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(configWrites).toHaveLength(1);

		pluginsFail = false;
		press();
		await waitFor(() => expect(pluginWrites).toHaveLength(2));
		expect(configWrites).toHaveLength(1);
		await waitFor(() => expect(saveButton()).toBeDisabled());
		expect(plugins).toHaveLength(2);
	});
});

describe("a value the page cannot accept", () => {
	it("names an incomplete plugin row beside it and sends nothing", async () => {
		mountPage();
		await ready();
		fireEvent.click(screen.getByRole("button", { name: "Add a plugin" }));
		await screen.findByText("Marketplace is required.");
		expect(saveButton()).toBeDisabled();
		press();
		expect(configWrites).toEqual([]);
		expect(pluginWrites).toEqual([]);
	});

	it("names an incomplete weekly reading, and clears the note once it is complete", async () => {
		mountPage();
		await ready();
		toggle("Post a weekly assistant reading");
		await screen.findByText(/before turning the weekly reading on/i);
		expect(saveButton()).toBeDisabled();

		type(/pinned issue key/, "ISS-1");
		type(/judge provider id/, "litellm");
		type(/judge model/, "cx/gpt-6-astra");
		await waitFor(() => expect(screen.queryByText(/before turning the weekly reading on/i)).toBeNull());
		expect(saveButton()).toBeEnabled();
	});

	it("refuses Draft in the backlog while the intake gate is on, and names why", async () => {
		mountPage();
		await ready();
		toggle("Require human approval for new issues");
		toggle("Show a backlog to this project's master agents");
		await screen.findByText(/Draft can’t also be admitted here/);
		expect(saveButton()).toBeDisabled();
		expect(configWrites).toEqual([]);
	});

	it("names a count outside its bounds beside the field", async () => {
		mountPage();
		await ready();
		type("Proposals per night", "40");
		await screen.findByText("Proposals per night must be at most 10.");
		expect(saveButton()).toBeDisabled();
	});
});

describe("a pool that names a box this project has no runner for", () => {
	it("holds Save, and says why in the bar", async () => {
		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-gone"] } } });
		mountPage();
		await ready();
		toggle("Require human approval for new issues");
		expect(saveButton()).toBeDisabled();
		expect(screen.getByText(/names a device this project has no runner for/i)).toBeInTheDocument();
	});

	it("can be cleared when the project has no runner at all, and the page saves once it is", async () => {
		runners = [];
		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-gone"] } } });
		mountPage();
		await ready();
		toggle("Require human approval for new issues");
		expect(saveButton()).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		await waitFor(() => expect(saveButton()).toBeEnabled());
		press();
		await waitFor(() => expect(configWrites).toHaveLength(1));
		expect(configWrites[0]?.patch).toEqual({
			intakeGate: { enabled: true },
			states: { open: { deviceIds: null } },
		});
	});
});
