// @vitest-environment jsdom
//
// ISS-1170 criterion 20. The refusal banner is the only way out of a `CONFIG_STALE` save, so
// what it does to the edits it was offered to rescue IS the criterion. Reproduced here at the
// layer the harm lives at: two sections of ONE page load, edits held in both, a second writer
// moving a path only one of them names.
//
// The store is the server's own contract, run from the same `@forge/contracts/document-patch`
// functions `updatePipelineConfig` calls, so a body the real route would refuse is refused here.

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
import { AssistantWeeklySection } from "./components/assistant-weekly-section";
import { StagePermissionsSection } from "./components/stage-permissions-section";
import { usePipelineConfig } from "./hooks";
import type { PipelineConfig } from "./types";

expect.extend(matchers);

type Doc = Record<string, unknown>;

let stored: Doc;
let sent: unknown[];

function patchPipelineConfig(body: unknown): { pipelineConfig: Doc } {
	sent.push(body);
	const write = body as { base?: unknown; patch?: Doc };
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
			if (path.endsWith("/pipeline-config")) return { pipelineConfig: structuredClone(stored) };
			throw new Error(`unmocked ${init?.method ?? "GET"} ${path}`);
		},
	};
});

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

/** What the tab holds when the person arrives. The Queued stage already denies one tool, so a
 *  second writer has something to move. */
const START: Doc = {
	enabled: true,
	states: { open: { enabled: true, mode: "auto", disallowedTools: ["Bash(rm:*)"] } },
	assistantWeekly: {
		enabled: true,
		pinnedIssue: "ISS-25",
		judgeProviderId: "litellm",
		judgeModel: "cx/gpt-6-astra",
	},
};

/** One read of the document, handed to every section — what `pipeline-tab.tsx` does. */
function Page() {
	const cfgQ = usePipelineConfig("p1");
	if (!cfgQ.data) return null;
	const config = cfgQ.data.pipelineConfig as PipelineConfig;
	return (
		<>
			<div data-testid="weekly">
				<AssistantWeeklySection projectId="p1" config={config} canEdit />
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

const pinnedField = () =>
	within(screen.getByTestId("weekly")).getByLabelText(
		/pinned issue key/i,
	) as HTMLInputElement;

/** The untouched section's unsaved edit — in no conflict with anybody. */
function typeInAssistantWeekly(value: string): void {
	fireEvent.change(pinnedField(), { target: { value } });
}

function expandQueued(): void {
	fireEvent.click(within(screen.getByTestId("perms")).getByRole("button", { name: /Queued/ }));
}

/** The colliding section's unsaved edit: one more denied tool id on Queued. */
async function typeADeniedTool(id: string): Promise<void> {
	const perms = within(screen.getByTestId("perms"));
	const field = await perms.findByLabelText("Add a tool id to Denied tools");
	fireEvent.change(field, { target: { value: id } });
	fireEvent.keyDown(field, { key: "Enter" });
}

/** The raw ids the Denied tools editor is showing, off each chip's own title. */
function deniedChips(): string[] {
	const perms = within(screen.getByTestId("perms"));
	const editor = perms.getByText("Denied tools").parentElement as HTMLElement;
	return within(editor)
		.getAllByRole("button")
		.map((el) => el.getAttribute("title"))
		.filter((t): t is string => t !== null);
}

async function saveQueuedPermissions(): Promise<void> {
	const perms = within(screen.getByTestId("perms"));
	fireEvent.click(perms.getByRole("button", { name: /save queued permissions/i }));
}

beforeEach(() => {
	stored = structuredClone(START);
	sent = [];
	toast.mockClear();
});
afterEach(cleanup);

describe("the way out of a refused save", () => {
	it("keeps the edits held in a section that never collided", async () => {
		mountPage();
		await screen.findByLabelText(/pinned issue key/i);

		expandQueued();
		typeInAssistantWeekly("ISS-9999-UNSAVED");
		await typeADeniedTool("qa_probe_typed_X");
		expect(pinnedField().value).toBe("ISS-9999-UNSAVED");
		expect(deniedChips()).toContain("qa_probe_typed_X");

		// A second writer moves the very path this stage's save names.
		stored = applyDocumentPatch(stored, {
			states: { open: { disallowedTools: ["Bash(rm:*)", "WebFetch"] } },
		});
		await saveQueuedPermissions();
		await screen.findByText(/changed by someone else/i);

		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));

		// The colliding path takes what is stored now — that is what the button says it does.
		await waitFor(() => expect(deniedChips()).toContain("WebFetch"));
		// And the section that never collided still holds what the person typed.
		expect(pinnedField().value).toBe("ISS-9999-UNSAVED");
		// The screen says what it replaced rather than leaving it to be noticed.
		const after = await screen.findByText(/loaded what is stored now/i);
		expect(after.textContent).toContain("Stage permissions (Queued)");
		expect(after.textContent).toMatch(/every other edit on this page is as you left it/i);
	});

	it("lets the person keep their own change and save over the other writer's", async () => {
		mountPage();
		await screen.findByLabelText(/pinned issue key/i);

		expandQueued();
		typeInAssistantWeekly("ISS-9999-UNSAVED");
		await typeADeniedTool("qa_probe_typed_X");

		stored = applyDocumentPatch(stored, {
			states: { open: { disallowedTools: ["Bash(rm:*)", "WebFetch"] } },
		});
		await saveQueuedPermissions();
		await screen.findByText(/changed by someone else/i);

		fireEvent.click(screen.getByRole("button", { name: /keep my changes/i }));
		// The stage header counts the STORED list, so it is what says the re-read has landed.
		await screen.findByText("2 denied");
		expect(deniedChips()).toContain("qa_probe_typed_X");

		const perms = within(screen.getByTestId("perms"));
		fireEvent.click(perms.getByRole("button", { name: /save queued permissions/i }));
		await waitFor(() =>
			expect((stored.states as Doc).open).toMatchObject({
				disallowedTools: ["Bash(rm:*)", "qa_probe_typed_X"],
			}),
		);
		expect(pinnedField().value).toBe("ISS-9999-UNSAVED");
	});

	it("replaces the colliding setting alone, not the section it sits in", async () => {
		mountPage();
		await screen.findByLabelText(/pinned issue key/i);
		expandQueued();

		await typeADeniedTool("qa_probe_typed_X");
		const perms = within(screen.getByTestId("perms"));
		const allowField = await perms.findByLabelText(
			"Add a tool id to Allowed tools (allowlist)",
		);
		fireEvent.change(allowField, { target: { value: "qa_probe_allowed_Y" } });
		fireEvent.keyDown(allowField, { key: "Enter" });

		stored = applyDocumentPatch(stored, {
			states: { open: { disallowedTools: ["Bash(rm:*)", "WebFetch"] } },
		});
		await saveQueuedPermissions();
		await screen.findByText(/changed by someone else/i);

		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));
		await waitFor(() => expect(deniedChips()).toContain("WebFetch"));
		expect(deniedChips()).not.toContain("qa_probe_typed_X");
		// The allowlist edit was in the same section and in no conflict: it stands.
		const editor = perms.getByText("Allowed tools (allowlist)").parentElement as HTMLElement;
		expect(
			within(editor)
				.getAllByRole("button")
				.map((el) => el.getAttribute("title")),
		).toContain("qa_probe_allowed_Y");
	});

	it("names what it will do to the edits it holds, before the button is pressed", async () => {
		mountPage();
		await screen.findByLabelText(/pinned issue key/i);
		expandQueued();
		await typeADeniedTool("qa_probe_typed_X");
		stored = applyDocumentPatch(stored, {
			states: { open: { disallowedTools: ["Bash(rm:*)", "WebFetch"] } },
		});
		await saveQueuedPermissions();
		await screen.findByText(/changed by someone else/i);

		const banner = screen.getByText(/changed by someone else/i).closest("div") as HTMLElement;
		expect(banner.textContent).toMatch(/your edits everywhere else on this page are kept/i);
	});
});
