// @vitest-environment jsdom
//
// The defect ISS-1170 names lives in what the SCREEN sends, so it is reproduced here by
// driving two sections of ONE page load and reading the stored document back. A test that
// asserted a merge helper in isolation would pass whatever the sections put on the wire,
// which is the half that was wrong.
//
// The store below is the server's own contract, run from the same
// `@forge/contracts/document-patch` functions `updatePipelineConfig` calls, so a body the
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
import { ApiError } from "@/lib/api/client";
import { usePipelineConfig } from "./hooks";
import { RunnerPoolsSection } from "./components/runner-pools-section";
import { StagePermissionsSection } from "./components/stage-permissions-section";
import type { PipelineConfig } from "./types";

expect.extend(matchers);

type Doc = Record<string, unknown>;
type States = Record<string, Record<string, unknown>>;

let stored: Doc;
/** Every body the screen put on the wire, in order. */
let sent: unknown[];
/** How many times the screen has read the document back. */
let reads: number;

function patchPipelineConfig(body: unknown): { pipelineConfig: Doc } {
	sent.push(body);
	const write = body as { base?: unknown; patch?: Doc } | null;
	if (!write || typeof write !== "object" || !("base" in write) || !("patch" in write)) {
		throw new ApiError(
			400,
			"a pipeline config write is `{ base, patch }`",
			"CONFIG_PATCH_SHAPE",
		);
	}
	const conflicts = comparePatchBase(stored, write.base, write.patch ?? {});
	if (conflicts.length > 0) {
		throw new ApiError(
			409,
			`the pipeline config changed since you read it — ${describeConflicts(conflicts)}. Nothing was written.`,
			"CONFIG_STALE",
			{ conflicts },
		);
	}
	stored = applyDocumentPatch(stored, write.patch ?? {});
	return { pipelineConfig: stored };
}

vi.mock("@/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
	return {
		...actual,
		apiClient: async (path: string, init?: { method?: string; body?: string }) => {
			if (path.endsWith("/pipeline-config") && init?.method === "PATCH") {
				return patchPipelineConfig(JSON.parse(init.body ?? "null"));
			}
			if (path.endsWith("/pipeline-config")) {
				reads += 1;
				return { pipelineConfig: structuredClone(stored) };
			}
			throw new Error(`unmocked ${init?.method ?? "GET"} ${path}`);
		},
	};
});

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

vi.mock("@/features/runners/hooks", () => ({
	useProjectRunners: () => ({
		data: [
			{ deviceId: "box-a", deviceName: "box-a", deviceStatus: "online", runnerStatus: "online" },
			{ deviceId: "box-b", deviceName: "box-b", deviceStatus: "online", runnerStatus: "online" },
		],
		isPending: false,
	}),
}));

/** What the tab is holding when the person arrives: one read, handed to every section. */
const START: Doc = {
	enabled: true,
	states: {
		open: { enabled: true, mode: "auto" },
		in_progress: { enabled: true, mode: "auto" },
	},
	intakeGate: { enabled: true, notify: true },
	knowledgePromotion: { enabled: true, candidatesPerRun: 3, minRetrievals: 2 },
};

function statesOf(doc: Doc): States {
	return doc.states as States;
}

/** One read of the document, handed to every section — what `pipeline-tab.tsx` does. */
function Page() {
	const cfgQ = usePipelineConfig("p1");
	if (!cfgQ.data) return null;
	const config = cfgQ.data.pipelineConfig as PipelineConfig;
	return (
		<>
			<div data-testid="pools">
				<RunnerPoolsSection projectId="p1" config={config} canEdit />
			</div>
			<div data-testid="perms">
				<StagePermissionsSection projectId="p1" config={config} canEdit deviceNames={{}} />
			</div>
		</>
	);
}

function mountPage() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Page />
		</QueryClientProvider>,
	);
}

function mount(config: PipelineConfig) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<div data-testid="pools">
				<RunnerPoolsSection projectId="p1" config={config} canEdit />
			</div>
			<div data-testid="perms">
				<StagePermissionsSection projectId="p1" config={config} canEdit deviceNames={{}} />
			</div>
		</QueryClientProvider>,
	);
}

/** The page load both sections were handed — one object, as `pipeline-tab.tsx` hands it. */
function pageLoad(): PipelineConfig {
	return structuredClone(stored) as PipelineConfig;
}

async function saveRunnerPool(device = "box-a"): Promise<void> {
	const pools = within(screen.getByTestId("pools"));
	fireEvent.click(pools.getByRole("button", { name: `Queued on ${device}` }));
	fireEvent.click(pools.getByRole("button", { name: /save runner pools/i }));
}

async function saveStagePermission(): Promise<void> {
	const perms = within(screen.getByTestId("perms"));
	fireEvent.click(perms.getByRole("button", { name: /Queued/ }));
	const boxes = await perms.findAllByRole("checkbox");
	fireEvent.click(boxes[0]);
	fireEvent.click(perms.getByRole("button", { name: /save queued permissions/i }));
}

beforeEach(() => {
	stored = structuredClone(START);
	sent = [];
	reads = 0;
	toast.mockClear();
});
afterEach(cleanup);

describe("two sections of one page load", () => {
	it("both land: neither save discards the other's key", async () => {
		mount(pageLoad());

		await saveRunnerPool();
		await waitFor(() => expect(statesOf(stored).open.deviceIds).toEqual(["box-a"]));

		await saveStagePermission();
		await waitFor(() => expect(statesOf(stored).open.mcpServers).toBeTruthy());

		// The whole point: the first section's key is still there after the second saved.
		expect(statesOf(stored).open.deviceIds).toEqual(["box-a"]);
	});

	it("each sends only its own section's keys", async () => {
		mount(pageLoad());

		await saveRunnerPool();
		await waitFor(() => expect(sent).toHaveLength(1));
		const pools = (sent[0] as { patch: Doc }).patch;
		expect(Object.keys(pools)).toEqual(["states"]);
		expect(Object.keys((pools.states as States).open)).toEqual(["deviceIds"]);

		await saveStagePermission();
		await waitFor(() => expect(sent).toHaveLength(2));
		const perms = (sent[1] as { patch: Doc }).patch;
		expect(Object.keys(perms)).toEqual(["states"]);
		expect(Object.keys((perms.states as States).open)).toEqual(["mcpServers"]);
	});

	it("let one section save twice in a row, each write against what it now holds", async () => {
		mountPage();
		await screen.findByRole("button", { name: "Queued on box-a" });

		await saveRunnerPool("box-a");
		await waitFor(() => expect(statesOf(stored).open.deviceIds).toEqual(["box-a"]));
		// The page re-seeds from what came back; the second edit is made on THAT, as a
		// person clicking twice would.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Queued on box-a" })).toHaveAttribute(
				"aria-pressed",
				"true",
			),
		);

		await saveRunnerPool("box-b");
		await waitFor(() => expect(statesOf(stored).open.deviceIds).toEqual(["box-a", "box-b"]));
		expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
	});

	it("leave a section nobody touched out of the wire entirely", async () => {
		mount(pageLoad());
		await saveRunnerPool();
		await waitFor(() => expect(sent).toHaveLength(1));
		const patch = (sent[0] as { patch: Doc }).patch;
		expect(patch).not.toHaveProperty("intakeGate");
		expect(patch).not.toHaveProperty("knowledgePromotion");
		expect(patch).not.toHaveProperty("enabled");
	});
});

describe("a write against a document that moved under it", () => {
	it("is refused, and the stored value stands", async () => {
		mount(pageLoad());

		// A second tab pins the same stage to a different box between this page's read and
		// its save.
		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-b"] } } });

		await saveRunnerPool();
		await screen.findByText(/changed by someone else/i);
		expect(statesOf(stored).open.deviceIds).toEqual(["box-b"]);
	});

	it("says which settings changed, and that nothing was saved", async () => {
		mount(pageLoad());
		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-b"] } } });
		await saveRunnerPool();
		const banner = await screen.findByText(/changed by someone else/i);
		expect(banner.textContent).toContain("Runner pools (Queued)");
		expect(banner.textContent).toMatch(/nothing was saved/i);
	});

	it("offers the re-read, which re-seeds the section from what is stored now", async () => {
		mountPage();
		await screen.findByRole("button", { name: "Queued on box-a" });
		const before = reads;

		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-b"] } } });
		await saveRunnerPool();
		await screen.findByText(/changed by someone else/i);

		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));
		await waitFor(() => expect(reads).toBeGreaterThan(before));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Queued on box-b" })).toHaveAttribute(
				"aria-pressed",
				"true",
			),
		);
	});

	it("does not refuse a second section that writes a different path", async () => {
		mount(pageLoad());
		// The stage-permissions save below writes `states.open.mcpServers`; a runner pool
		// landing at `states.open.deviceIds` moves no path it names.
		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-b"] } } });
		await saveStagePermission();
		await waitFor(() => expect(statesOf(stored).open.mcpServers).toBeTruthy());
		expect(statesOf(stored).open.deviceIds).toEqual(["box-b"]);
	});
});
