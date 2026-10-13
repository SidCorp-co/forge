// @vitest-environment jsdom
//
// ISS-1170 criterion 20, kept under ISS-1262's one form. The refusal banner is the only way out of a
// `CONFIG_STALE` save, so what it does to the edits it was offered to rescue IS the criterion.
// Reproduced at the layer the harm lives at: ONE page holding edits in two sections, and a second
// writer moving a path only one of them names.
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
let failNextWriteWith: ApiError | null = null;
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
				if (failNextWriteWith) {
					const refusal = failNextWriteWith;
					failNextWriteWith = null;
					throw refusal;
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

let client: QueryClient;
function mountPage() {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
const reread = () => client.invalidateQueries({ queryKey: ["project", "p1", "pipeline-config"] });
const expandOpenStage = () =>
	fireEvent.click(
		screen
			.getAllByRole("button")
			.find((b) => b.hasAttribute("aria-expanded") && /^Open/.test(b.textContent ?? "")) as HTMLElement,
	);

beforeEach(() => {
	sent = [];
	failNextWriteWith = null;
	reads = 0;
	toast.mockClear();
});
afterEach(cleanup);

/** What the page holds when the person arrives. The Open stage already denies one tool, so a second
 *  writer has something to move. */
const START: Doc = {
	enabled: true,
	states: { open: { enabled: true, mode: "auto", disallowedTools: ["Bash(rm:*)"] } },
	knowledgePromotion: { enabled: true, candidatesPerRun: 3, minRetrievals: 2 },
	assistantWeekly: {
		enabled: true,
		pinnedIssue: "ISS-25",
		judgeProviderId: "litellm",
		judgeModel: "cx/gpt-6-astra",
	},
};

beforeEach(() => {
	stored = structuredClone(START);
});

const pinnedField = () => screen.getByLabelText(/pinned issue key/i) as HTMLInputElement;
const retrievalsField = () =>
	screen.getByLabelText("Minimum retrievals before a memory is eligible") as HTMLInputElement;

/** The untouched section's unsaved edit — in no conflict with anybody. */
const typeInAssistantWeekly = (value: string) =>
	fireEvent.change(pinnedField(), { target: { value } });

/** The colliding section's unsaved edit: one more denied tool id on Open. */
async function typeADeniedTool(id: string): Promise<void> {
	const field = await screen.findByLabelText("Add a tool id to Denied tools");
	fireEvent.change(field, { target: { value: id } });
	fireEvent.keyDown(field, { key: "Enter" });
}

/** The raw ids the Denied tools editor is showing, off each chip's own title. */
function deniedChips(): string[] {
	const editor = screen.getByText("Denied tools").parentElement as HTMLElement;
	return within(editor)
		.getAllByRole("button")
		.map((el) => el.getAttribute("title"))
		.filter((t): t is string => t !== null);
}

const moveDeniedTools = () => {
	stored = applyDocumentPatch(stored, {
		states: { open: { disallowedTools: ["Bash(rm:*)", "WebFetch"] } },
	});
};

describe("a re-read of the document", () => {
	it("keeps the edits held in two sections and shows the stored value at the path nobody edited", async () => {
		mountPage();
		await ready();
		expandOpenStage();
		typeInAssistantWeekly("ISS-9999-UNSAVED");
		await typeADeniedTool("qa_probe_typed_X");

		stored = applyDocumentPatch(stored, { knowledgePromotion: { minRetrievals: 9 } });
		await reread();

		await waitFor(() => expect(retrievalsField().value).toBe("9"));
		expect(pinnedField().value).toBe("ISS-9999-UNSAVED");
		expect(deniedChips()).toContain("qa_probe_typed_X");
	});

	it("is not a re-read when the same document comes back", async () => {
		mountPage();
		await ready();
		typeInAssistantWeekly("ISS-9999-UNSAVED");
		const before = reads;
		await reread();
		await waitFor(() => expect(reads).toBeGreaterThan(before));
		expect(pinnedField().value).toBe("ISS-9999-UNSAVED");
		expect(screen.queryByText(/loaded what is stored now/i)).toBeNull();
	});
});

describe("the way out of a refused save", () => {
	it("keeps the edits held in a section that never collided", async () => {
		mountPage();
		await ready();
		expandOpenStage();
		typeInAssistantWeekly("ISS-9999-UNSAVED");
		await typeADeniedTool("qa_probe_typed_X");
		expect(deniedChips()).toContain("qa_probe_typed_X");

		// A second writer moves the very path this stage's edit names.
		moveDeniedTools();
		press();
		await screen.findByText(/changed by someone else/i);

		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));

		// The colliding path takes what is stored now — that is what the button says it does.
		await waitFor(() => expect(deniedChips()).toContain("WebFetch"));
		// And the section that never collided still holds what the person typed.
		expect(pinnedField().value).toBe("ISS-9999-UNSAVED");
		// The screen says what it replaced rather than leaving it to be noticed.
		const after = await screen.findByText(/loaded what is stored now/i);
		expect(after.textContent).toContain("Stage permissions (Open)");
		expect(after.textContent).toMatch(/every other edit on this page is as you left it/i);
	});

	it("still takes the stored values when a background read had already landed before the button was pressed", async () => {
		mountPage();
		await ready();
		expandOpenStage();
		await typeADeniedTool("qa_probe_typed_X");

		moveDeniedTools();
		press();
		await screen.findByText(/changed by someone else/i);
		// The window regained focus and the document was read again: the draft is now seeded from
		// the very document the button's own re-read is about to return.
		const before = reads;
		await reread();
		await waitFor(() => expect(reads).toBeGreaterThan(before));

		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));

		await waitFor(() => expect(deniedChips()).toContain("WebFetch"));
		expect(deniedChips()).not.toContain("qa_probe_typed_X");
		const after = await screen.findByText(/loaded what is stored now/i);
		expect(after.textContent).toContain("Stage permissions (Open)");
	});

	it("says in grammar what was replaced and what was kept when one section is only partly replaced", async () => {
		mountPage();
		await ready();
		fireEvent.change(retrievalsField(), { target: { value: "7" } });
		fireEvent.change(screen.getByLabelText("Proposals per night"), { target: { value: "5" } });

		stored = applyDocumentPatch(stored, { knowledgePromotion: { minRetrievals: 9 } });
		press();
		const refused = await screen.findByText(/changed by someone else/i);
		expect(refused.textContent).toMatch(/^Knowledge promotion \(Minimum retrievals\) was changed by someone else/);

		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));
		const after = await screen.findByText(/loaded what is stored now/i);
		expect(after.textContent).toContain(
			"Your changes to Knowledge promotion (Minimum retrievals) were replaced by the stored values; your changes to Knowledge promotion (Proposals per night) were kept.",
		);
		expect((screen.getByLabelText("Proposals per night") as HTMLInputElement).value).toBe("5");
		expect(retrievalsField().value).toBe("9");
	});

	it("names every field of a section that moved when two of them did, and says were", async () => {
		mountPage();
		await ready();
		fireEvent.change(retrievalsField(), { target: { value: "7" } });
		fireEvent.change(screen.getByLabelText("Proposals per night"), { target: { value: "5" } });

		stored = applyDocumentPatch(stored, { knowledgePromotion: { minRetrievals: 9, candidatesPerRun: 8 } });
		press();
		const refused = await screen.findByText(/changed by someone else/i);
		expect(refused.textContent).toMatch(
			/^Knowledge promotion \(Proposals per night and Minimum retrievals\) were changed by someone else/,
		);
		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));
		const after = await screen.findByText(/loaded what is stored now/i);
		expect(after.textContent).toContain(
			"Your changes to Knowledge promotion (Proposals per night and Minimum retrievals) were replaced by the stored values. Every other edit",
		);
	});

	it("lets the person keep their own change and save over the other writer's", async () => {
		mountPage();
		await ready();
		expandOpenStage();
		typeInAssistantWeekly("ISS-9999-UNSAVED");
		await typeADeniedTool("qa_probe_typed_X");

		moveDeniedTools();
		press();
		await screen.findByText(/changed by someone else/i);

		fireEvent.click(screen.getByRole("button", { name: /keep my changes/i }));
		// The stage header counts the STORED list, so it is what says the re-read has landed.
		await screen.findByText("2 denied");
		expect(deniedChips()).toContain("qa_probe_typed_X");

		press();
		await waitFor(() =>
			expect(statesOf(stored).open).toMatchObject({
				disallowedTools: ["Bash(rm:*)", "qa_probe_typed_X"],
			}),
		);
		expect((stored.assistantWeekly as Doc).pinnedIssue).toBe("ISS-9999-UNSAVED");
	});

	it("replaces the colliding setting alone, not the section it sits in", async () => {
		mountPage();
		await ready();
		expandOpenStage();
		await typeADeniedTool("qa_probe_typed_X");
		const allowField = await screen.findByLabelText("Add a tool id to Allowed tools (allowlist)");
		fireEvent.change(allowField, { target: { value: "qa_probe_allowed_Y" } });
		fireEvent.keyDown(allowField, { key: "Enter" });

		moveDeniedTools();
		press();
		await screen.findByText(/changed by someone else/i);

		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));
		await waitFor(() => expect(deniedChips()).toContain("WebFetch"));
		expect(deniedChips()).not.toContain("qa_probe_typed_X");
		// The allowlist edit was in the same section and in no conflict: it stands.
		const editor = screen.getByText("Allowed tools (allowlist)").parentElement as HTMLElement;
		expect(
			within(editor)
				.getAllByRole("button")
				.map((el) => el.getAttribute("title")),
		).toContain("qa_probe_allowed_Y");
	});

	it("names what it will do to the edits it holds, before the button is pressed", async () => {
		mountPage();
		await ready();
		expandOpenStage();
		await typeADeniedTool("qa_probe_typed_X");
		moveDeniedTools();
		press();
		await screen.findByText(/changed by someone else/i);

		const banner = screen.getByText(/changed by someone else/i).closest("div") as HTMLElement;
		expect(banner.textContent).toMatch(/your edits everywhere else on this page are kept/i);
		expect(banner.textContent).toMatch(/nothing was saved/i);
	});

	it("tells the Denied tools edit from the Allowed tools edit of one stage when only one is replaced", async () => {
		mountPage();
		await ready();
		expandOpenStage();
		await typeADeniedTool("qa_probe_typed_X");
		const allowed = await screen.findByLabelText("Add a tool id to Allowed tools (allowlist)");
		fireEvent.change(allowed, { target: { value: "qa_probe_allowed_Y" } });
		fireEvent.keyDown(allowed, { key: "Enter" });

		moveDeniedTools();
		press();
		const refused = await screen.findByText(/changed by someone else/i);
		expect(refused.textContent).toMatch(/^Stage permissions \(Open\) \(Denied tools\) was changed/);

		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));
		const after = await screen.findByText(/loaded what is stored now/i);
		expect(after.textContent).toContain("Your changes to Stage permissions (Open) (Denied tools) were replaced");
		expect(after.textContent).toContain("your changes to Stage permissions (Open) (Allowed tools) were kept");
		await waitFor(() => expect(deniedChips()).toContain("WebFetch"));
		expect(deniedChips()).not.toContain("qa_probe_typed_X");
		const editor = screen.getByText("Allowed tools (allowlist)").parentElement as HTMLElement;
		expect(within(editor).getAllByRole("button").map((el) => el.getAttribute("title"))).toContain("qa_probe_allowed_Y");
	});

	it("shows a refusal that is not a conflict whole on a phone, since nothing else offers to expand it", async () => {
		mountPage();
		await ready();
		fireEvent.click(screen.getByRole("switch", { name: "Pipeline enabled" }));
		failNextWriteWith = new ApiError(
			409,
			"enabled auto-stage toggles require a registered skill for the corresponding stage",
			"MISSING_SKILL_FOR_ENABLED_STAGE",
			{ stagesMissingSkill: ["open"] },
		);
		press();
		const message = await screen.findByText(/needs a registered skill/i);
		expect(message.className).not.toContain("line-clamp");
	});

	it("keeps the refusal compact on a phone: the message is two lines and the choice is folded behind a toggle", async () => {
		mountPage();
		await ready();
		expandOpenStage();
		await typeADeniedTool("qa_probe_typed_X");
		moveDeniedTools();
		press();
		const message = await screen.findByText(/changed by someone else/i);
		expect(message.className).toContain("line-clamp-2");
		expect(message.className).toContain("md:line-clamp-none");

		const choice = screen.getByRole("button", { name: /use the current values/i }).parentElement?.parentElement as HTMLElement;
		expect(choice.className).toContain("hidden");
		expect(choice.className).toContain("md:block");

		const toggle = screen.getByRole("button", { name: "Choose what to do" });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		fireEvent.click(toggle);
		expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-expanded", "true");
		expect(choice.className).not.toContain("hidden");
		expect(message.className).not.toContain("line-clamp-2");
	});
});
