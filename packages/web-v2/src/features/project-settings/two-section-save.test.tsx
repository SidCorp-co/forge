// @vitest-environment jsdom
//
// The defect ISS-1170 names lives in what the SCREEN sends, so it is reproduced here by driving two
// sections of ONE page and reading the stored document back. A test that asserted a merge helper in
// isolation would pass whatever the page put on the wire, which is the half that was wrong. ISS-1262
// made the page one form with one Save, so what is proved now is that one Save carries both sections'
// keys without either discarding the other's.
//
// The store is the server's own contract, run from the same `@forge/contracts/document-patch`
// functions `updatePipelineConfig` calls, so a body the real route would refuse is refused here too.

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
type States = Record<string, Record<string, unknown>>;

let stored: Doc;
/** Every body the page put on the wire, in order. */
let sent: unknown[];
/** How many times the page has read the document back. */
let reads: number;

vi.mock("@/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
	return {
		...actual,
		apiClient: async (path: string, init?: { method?: string; body?: string }) => {
			if (path.endsWith("/pipeline-config") && init?.method === "PATCH") {
				const write = JSON.parse(init.body ?? "null") as { base: Doc; patch: Doc } | null;
				sent.push(write);
				if (!write || typeof write !== "object" || !("base" in write) || !("patch" in write)) {
					throw new ApiError(400, "a pipeline config write is `{ base, patch }`", "CONFIG_PATCH_SHAPE");
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
			if (path.endsWith("/pipeline-config")) {
				reads += 1;
				return { pipelineConfig: structuredClone(stored) };
			}
			if (path === "/projects/p1") return { id: "p1", agentConfig: {} };
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
		data: [
			{ deviceId: "box-a", deviceName: "box-a", deviceStatus: "online", runnerStatus: "online" },
			{ deviceId: "box-b", deviceName: "box-b", deviceStatus: "online", runnerStatus: "online" },
		],
		isPending: false,
	}),
}));

const statesOf = (doc: Doc): States => doc.states as States;

function mountPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<LeaveGuardProvider>
				<PipelineTab projectId="p1" canEdit slug="forge" />
			</LeaveGuardProvider>
		</QueryClientProvider>,
	);
}

const ready = () => screen.findByRole("switch", { name: "Pipeline enabled" });
const press = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));
const expandOpenStage = () =>
	fireEvent.click(
		screen
			.getAllByRole("button")
			.find((b) => b.hasAttribute("aria-expanded") && /^Open/.test(b.textContent ?? "")) as HTMLElement,
	);
const pool = (stage: string, device: string) =>
	screen.getByRole("button", { name: `${stage} on ${device}` });

beforeEach(() => {
	sent = [];
	reads = 0;
	toast.mockClear();
});
afterEach(cleanup);

const START: Doc = {
	enabled: true,
	states: { open: { enabled: true, mode: "auto" }, in_progress: { enabled: true, mode: "auto" } },
	intakeGate: { enabled: true, notify: true },
	knowledgePromotion: { enabled: true, candidatesPerRun: 3, minRetrievals: 2 },
};

beforeEach(() => {
	stored = structuredClone(START);
});

async function pinOpenToBoxA() {
	await ready();
	fireEvent.click(pool("Open", "box-a"));
}

async function tickFirstOpenMcpServer() {
	expandOpenStage();
	const boxes = await screen.findAllByRole("checkbox");
	fireEvent.click(boxes[0] as HTMLElement);
}

describe("two sections edited, one Save", () => {
	it("lands both: neither section's key is discarded by the other's", async () => {
		mountPage();
		await pinOpenToBoxA();
		await tickFirstOpenMcpServer();
		press();

		await waitFor(() => expect(statesOf(stored).open?.mcpServers).toBeTruthy());
		expect(statesOf(stored).open?.deviceIds).toEqual(["box-a"]);
		expect(sent).toHaveLength(1);
	});

	it("sends only the keys the two sections moved", async () => {
		mountPage();
		await pinOpenToBoxA();
		await tickFirstOpenMcpServer();
		press();

		await waitFor(() => expect(sent).toHaveLength(1));
		const patch = (sent[0] as { patch: Doc }).patch;
		expect(Object.keys(patch)).toEqual(["states"]);
		expect(Object.keys((patch.states as States).open ?? {}).sort()).toEqual(["deviceIds", "mcpServers"]);
	});

	it("lets the page save twice in a row, each write against what it now holds", async () => {
		mountPage();
		await pinOpenToBoxA();
		press();
		await waitFor(() => expect(statesOf(stored).open?.deviceIds).toEqual(["box-a"]));
		await waitFor(() => expect(pool("Open", "box-a")).toHaveAttribute("aria-pressed", "true"));
		await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());

		fireEvent.click(pool("Open", "box-b"));
		press();
		await waitFor(() => expect(statesOf(stored).open?.deviceIds).toEqual(["box-a", "box-b"]));
		expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
	});

	it("leaves a section nobody touched out of the wire entirely", async () => {
		mountPage();
		await pinOpenToBoxA();
		press();
		await waitFor(() => expect(sent).toHaveLength(1));
		const patch = (sent[0] as { patch: Doc }).patch;
		expect(patch).not.toHaveProperty("intakeGate");
		expect(patch).not.toHaveProperty("knowledgePromotion");
		expect(patch).not.toHaveProperty("enabled");
	});
});

describe("a write against a document that moved under it", () => {
	it("is refused, and the stored value stands", async () => {
		mountPage();
		await pinOpenToBoxA();
		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-b"] } } });
		press();

		await screen.findByText(/changed by someone else/i);
		expect(statesOf(stored).open?.deviceIds).toEqual(["box-b"]);
	});

	it("says which settings changed, and that nothing was saved", async () => {
		mountPage();
		await pinOpenToBoxA();
		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-b"] } } });
		press();

		const banner = await screen.findByText(/changed by someone else/i);
		expect(banner.textContent).toContain("Runner pools (Open)");
		expect(banner.textContent).toMatch(/nothing was saved/i);
	});

	it("offers the re-read, which re-seeds the page from what is stored now", async () => {
		mountPage();
		await pinOpenToBoxA();
		const before = reads;
		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-b"] } } });
		press();
		await screen.findByText(/changed by someone else/i);

		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));
		await waitFor(() => expect(reads).toBeGreaterThan(before));
		await waitFor(() => expect(pool("Open", "box-b")).toHaveAttribute("aria-pressed", "true"));
		expect(pool("Open", "box-a")).toHaveAttribute("aria-pressed", "false");
	});

	it("does not refuse a section that writes a different path from the one that moved", async () => {
		mountPage();
		await ready();
		await tickFirstOpenMcpServer();
		stored = applyDocumentPatch(stored, { states: { open: { deviceIds: ["box-b"] } } });
		press();

		await waitFor(() => expect(statesOf(stored).open?.mcpServers).toBeTruthy());
		expect(statesOf(stored).open?.deviceIds).toEqual(["box-b"]);
	});
});

describe("the one Save sits in the page", () => {
	it("is inside no section and is the only control by that name", async () => {
		mountPage();
		await ready();
		expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
		expect(within(document.body).queryAllByRole("button", { name: /^save .+/i })).toHaveLength(0);
	});
});
