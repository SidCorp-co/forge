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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
/** What the plugins route says when it fails: its own words, or only the HTTP status text a bare 500 carries. */
let pluginsFailsWith: string;
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
				// Core's own refusal (pipeline-config-service.ts, OPEN_LOCKED_ON): the Open stage is never disabled.
				if ((write.patch.states as Doc | undefined)?.open && ((write.patch.states as Doc).open as Doc).enabled === false) {
					throw new ApiError(409, "The Open stage can't be disabled", "OPEN_LOCKED_ON");
				}
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
				if (pluginsFail) throw new ApiError(500, pluginsFailsWith, "SERVER_ERROR");
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
	pluginsFailsWith = "the plugins store is down";
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

// ISS-1171: the release card moved to Shape & release, and the ten sections left read as three groups.
describe("the page's layout", () => {
	it("carries no release card", async () => {
		mountPage();
		await ready();
		expect(screen.queryByText(/Can this project release/)).toBeNull();
		expect(screen.queryByText("Release chain")).toBeNull();
		expect(screen.queryByText(/Why a release will not start/)).toBeNull();
	});

	it("puts its sections under three group headings", async () => {
		mountPage();
		await ready();
		for (const heading of ["What a session gets", "Where and when work is taken", "Background work"]) {
			expect(screen.getByRole("region", { name: heading })).toBeInTheDocument();
		}
		expect(
			within(screen.getByRole("region", { name: "Where and when work is taken" })).getByText("Runner pools"),
		).toBeInTheDocument();
	});

	// ISS-1229: a draft with nothing merged cannot be closed, so the gate's way out is Dropped.
	it("tells a person to turn an intake issue down by dropping it, never by closing it", async () => {
		mountPage();
		await ready();
		expect(screen.getByText(/reject by dropping it/)).toBeInTheDocument();
		expect(screen.queryByText(/reject by closing it/)).toBeNull();
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

describe("Start queued issues automatically", () => {
	const SWITCH = "Start queued issues automatically";

	it("is switched off by holding the entry gate, which is a mode and never a disabled Open stage", async () => {
		mountPage();
		await ready();
		toggle(SWITCH);
		expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "false");
		press();

		await waitFor(() => expect(configWrites).toHaveLength(1));
		expect(configWrites[0]?.patch).toEqual({ states: { open: { mode: "manual" } } });
		await waitFor(() => expect((stored.states as Doc).open).toMatchObject({ enabled: true, mode: "manual" }));
		expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
	});

	it("is switched back on by releasing the gate", async () => {
		stored = applyDocumentPatch(stored, { states: { open: { mode: "manual" } } });
		mountPage();
		await ready();
		expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "false");
		toggle(SWITCH);
		press();

		await waitFor(() => expect(configWrites).toHaveLength(1));
		expect(configWrites[0]?.patch).toEqual({ states: { open: { mode: "auto" } } });
	});

	it("never writes a disabled Open stage, whichever way the person flips it", async () => {
		mountPage();
		await ready();
		toggle(SWITCH);
		toggle(SWITCH);
		toggle(SWITCH);
		press();
		await waitFor(() => expect(configWrites).toHaveLength(1));
		expect(JSON.stringify(configWrites)).not.toContain('"enabled":false');
	});

	it("turns a legacy disabled Open stage back on, which the server accepts", async () => {
		stored = applyDocumentPatch(stored, { states: { open: { enabled: false } } });
		mountPage();
		await ready();
		toggle(SWITCH);
		press();
		await waitFor(() => expect(configWrites).toHaveLength(1));
		expect(configWrites[0]?.patch).toEqual({ states: { open: { enabled: true } } });
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
		expect(banner.textContent).toBe(
			"The pipeline settings were saved, but the plugins were not. The plugins store is down. Your plugin edits are still here — Save sends them again.",
		);
		expect((stored.intakeGate as Doc).enabled).toBe(true);
	});

	it("does not echo a bare HTTP status text, and still ends the reason before the next sentence", async () => {
		pluginsFail = true;
		pluginsFailsWith = "Internal Server Error";
		await editBoth();
		press();

		const banner = await screen.findByText(/the pipeline settings were saved, but the plugins were not/i);
		expect(banner.textContent).toBe(
			"The pipeline settings were saved, but the plugins were not. The server ran into a problem and could not finish the request. Your plugin edits are still here — Save sends them again.",
		);
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

	it("renders a plugin row's error as the field's own error, red, on the field it is about", async () => {
		mountPage();
		await ready();
		fireEvent.click(screen.getByRole("button", { name: "Add a plugin" }));
		const message = await screen.findByText("Marketplace is required.");
		expect(message).toHaveAttribute("role", "alert");
		expect(message.getAttribute("style")).toContain("var(--red-600)");
		const marketplace = screen.getAllByPlaceholderText("SidCorp-co/forge-plugin")[1] as HTMLElement;
		expect(marketplace).toHaveAttribute("aria-invalid", "true");
		expect(marketplace.getAttribute("aria-describedby")).toBe(message.id);

		fireEvent.change(marketplace, { target: { value: "SidCorp-co/forge-plugin" } });
		const names = screen.getAllByPlaceholderText("forge");
		fireEvent.change(names[1] as HTMLElement, { target: { value: "Not Kebab" } });
		const name = await screen.findByText("Name must be kebab-case.");
		expect(names[1]).toHaveAttribute("aria-invalid", "true");
		expect(name.getAttribute("style")).toContain("var(--red-600)");
		expect(screen.queryByText("Marketplace is required.")).toBeNull();
	});

	it("marks each empty field of an incomplete weekly reading, and clears each as it is filled", async () => {
		mountPage();
		await ready();
		toggle("Post a weekly assistant reading");
		const pinned = await screen.findByText("Fill in the pinned issue before turning the weekly reading on.");
		expect(pinned).toHaveAttribute("role", "alert");
		expect(pinned.getAttribute("style")).toContain("var(--red-600)");
		const fields = [/pinned issue key/, /judge provider id/, /judge model/].map(
			(label) => screen.getByLabelText(label) as HTMLElement,
		);
		for (const field of fields) expect(field).toHaveAttribute("aria-invalid", "true");
		expect(fields[0]?.getAttribute("aria-describedby")).toBe(pinned.id);
		expect(screen.getByText("Fill in the judge provider id before turning the weekly reading on.")).toBeInTheDocument();
		expect(screen.getByText("Fill in the judge model before turning the weekly reading on.")).toBeInTheDocument();
		expect(saveButton()).toBeDisabled();

		type(/pinned issue key/, "ISS-1");
		await waitFor(() => expect(screen.queryByText(/Fill in the pinned issue/)).toBeNull());
		expect(fields[0]).not.toHaveAttribute("aria-invalid");
		expect(fields[1]).toHaveAttribute("aria-invalid", "true");
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
		fireEvent.click(screen.getByRole("checkbox", { name: "Draft" }));
		await screen.findByText(/Draft can’t also be admitted here/);
		expect(saveButton()).toBeDisabled();
		expect(configWrites).toEqual([]);
	});

	it("admits no Draft when the backlog is switched on under the intake gate, so nothing is named before the person acts", async () => {
		stored = applyDocumentPatch(stored, { intakeGate: { enabled: true } });
		mountPage();
		await ready();
		toggle("Show a backlog to this project's master agents");
		expect(screen.queryByText(/Draft can’t also be admitted here/)).toBeNull();
		expect(screen.getByRole("checkbox", { name: "Draft" })).not.toBeChecked();
		expect(screen.getByRole("checkbox", { name: "Confirmed" })).toBeChecked();
		expect(saveButton()).toBeEnabled();
	});

	it("admits Draft first when there is no intake gate", async () => {
		mountPage();
		await ready();
		toggle("Show a backlog to this project's master agents");
		expect(screen.getByRole("checkbox", { name: "Draft" })).toBeChecked();
	});

	it("names a backlog limit outside its bounds, and stops naming it once the backlog is switched off", async () => {
		mountPage();
		await ready();
		toggle("Show a backlog to this project's master agents");
		type("Backlog rows a master may read at once", "0");
		await screen.findByText("Backlog rows must be at least 1.");
		expect(saveButton()).toBeDisabled();
		toggle("Show a backlog to this project's master agents");
		await waitFor(() => expect(screen.queryByText("Backlog rows must be at least 1.")).toBeNull());
		expect(screen.queryByText(/Fix what is marked above/)).toBeNull();
		expect(screen.getByText("No unsaved changes.")).toBeInTheDocument();
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
