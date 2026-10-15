// @vitest-environment jsdom
//
// Project settings → Shape & release (ISS-1171). Two halves: the environments document it writes
// as a `{ base, patch }` (carried over from the Testing tab, ISS-1170 — clearing the three preview
// fields it renders may null neither the preview object nor any key the form never showed), and
// the project row's shape. What is asserted is what the page puts on the wire and the STORED
// document after a save, through the server's own contract.

import { applyDocumentPatch, comparePatchBase } from "@forge/contracts/document-patch";
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaveGuardProvider } from "@/design";
import { NO_ISSUE_BUCKETS } from "@/features/issues/key-refusal";
import type { ProjectDetail } from "@/features/projects/types";
import { ApiError } from "@/lib/api/client";
import { ShapeTab } from "./components/shape-tab";
import type { ReleaseChainEntry, ReleaseReadiness } from "./types";

expect.extend(matchers);

type Doc = Record<string, unknown>;

let stored: Doc;
let sent: unknown[];
/** Every project PATCH body the page put on the wire. */
let projectSent: Array<Record<string, unknown>>;
/** What the next project PATCH answers with, where a case plants a refusal. */
let projectRefusal: ApiError | null;
/** What the next environments PATCH answers with, where a case plants a failure. */
let envFailure: ApiError | null;
/** Issues per status, as the list's buckets count them. */
let counts: Record<string, number>;
/** Held open, or made to fail, by the cases about a read that has not landed. */
let held: Promise<void> | null;
let fails: boolean;
let client: QueryClient;

function readiness(chain: ReleaseChainEntry[]): ReleaseReadiness {
	return {
		hasReleaseGate: chain.length > 0,
		releaseChain: chain,
		releaseModel: chain.length === 0 ? "none" : chain.length === 1 ? "publish" : "promote",
		releaseStrategy: null,
		baseBranch: "main",
		liveBranch: null,
		targetUndeclared: false,
		providers: [],
		releaseRunnerLabel: null,
		rollback: null,
		rollbackMode: null,
		hasVerify: false,
		declarationRead: true,
		channelsRead: true,
		blockers: [],
		warnings: [],
		gaps: [],
	} as unknown as ReleaseReadiness;
}

let currentChain: ReleaseChainEntry[];

vi.mock("@/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
	return {
		...actual,
		apiClient: async (path: string, init?: { method?: string; body?: string }) => {
			if (path.endsWith("/environments") && init?.method === "PATCH") {
				const write = JSON.parse(init.body ?? "null") as { base: Doc; patch: Doc };
				sent.push(write);
				if (envFailure) throw envFailure;
				if (!write || !("base" in write) || !("patch" in write)) {
					throw new ApiError(400, "an environments write is `{ base, patch }`", "ENVIRONMENTS_WRITE_SHAPE");
				}
				const conflicts = comparePatchBase(stored, write.base, write.patch);
				if (conflicts.length > 0) {
					throw new ApiError(409, "the environments settings changed", "ENVIRONMENTS_STALE", {
						conflicts,
					});
				}
				stored = applyDocumentPatch(stored, write.patch);
				return { environments: stored };
			}
			if (path.endsWith("/environments")) {
				if (fails) throw new ApiError(500, "the environments read failed", "SERVER_ERROR");
				if (held) await held;
				return { environments: structuredClone(stored) };
			}
			if (path === "/projects/p1" && init?.method === "PATCH") {
				projectSent.push(JSON.parse(init.body ?? "{}"));
				if (projectRefusal) throw projectRefusal;
				return {};
			}
			if (path.endsWith("/release-readiness")) return readiness(currentChain);
			if (path.endsWith("/integrations")) return { items: [], bindings: [] };
			throw new Error(`unmocked ${init?.method ?? "GET"} ${path}`);
		},
		apiClientList: async (path: string) => {
			if (path.includes("/issues/search")) {
				return {
					items: [],
					totalCount: 0,
					extra: { buckets: { ...NO_ISSUE_BUCKETS, byStatus: { ...NO_ISSUE_BUCKETS.byStatus, ...counts } } },
				};
			}
			throw new Error(`unmocked list ${path}`);
		},
	};
});

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

/** A stored preview carrying one key this form never renders. */
const START: Doc = {
	live: { url: "https://live.example", commitUrl: null, commitPath: null },
	preview: {
		url: "https://preview.example",
		apiUrl: "https://api.preview.example",
		urls: [{ label: "Mailbox", url: "https://mail.example" }],
		deployHookId: "hook-77",
	},
	testCredentials: [{ label: "QA", username: "qa@example.com", password: "s3cret" }],
	limits: "The QA account is not a member of every project.",
};

function project(over: Partial<ProjectDetail> = {}): ProjectDetail {
	return {
		id: "p1",
		slug: "desk",
		name: "Desk",
		kind: "standard",
		repoPath: "/srv/desk",
		repoUrl: null,
		workspaceSetup: null,
		baseBranch: "main",
		releaseChain: [{ branch: "main" }],
		...over,
	} as unknown as ProjectDetail;
}

function draw(p: ProjectDetail) {
	currentChain = (p.releaseChain ?? []) as ReleaseChainEntry[];
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	client = qc;
	return render(
		<QueryClientProvider client={qc}>
			<LeaveGuardProvider>
				<ShapeTab project={p} canEdit />
			</LeaveGuardProvider>
		</QueryClientProvider>,
	);
}

async function mount(p: ProjectDetail = project()) {
	const view = draw(p);
	// The form seeds from the environments document's own read, so nothing is on screen until
	// that read lands (ISS-1170).
	await screen.findByDisplayValue("https://preview.example");
	return view;
}

function clear(label: RegExp | string) {
	const field = screen.getByLabelText(label);
	fireEvent.change(field, { target: { value: "" } });
}

function save() {
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

beforeEach(() => {
	stored = structuredClone(START);
	sent = [];
	projectSent = [];
	projectRefusal = null;
	envFailure = null;
	counts = {};
	held = null;
	fails = false;
	toast.mockClear();
});
afterEach(cleanup);

describe("clearing every rendered preview field", () => {
	beforeEach(async () => {
		await mount();
		clear(/preview url/i);
		clear(/preview api url/i);
		fireEvent.click(screen.getAllByRole("button", { name: /remove/i })[0]);
		save();
		await waitFor(() => expect(sent).toHaveLength(1));
	});

	it("leaves the key the form never showed exactly as it was", () => {
		expect((stored.preview as Doc).deployHookId).toBe("hook-77");
	});

	it("does not null the preview object", () => {
		expect(stored.preview).not.toBeNull();
	});

	it("clears the three keys it does render", () => {
		const preview = stored.preview as Doc;
		expect(preview.url).toBeUndefined();
		expect(preview.apiUrl).toBeUndefined();
		expect(preview.urls).toBeUndefined();
	});

	it("names no path outside the fields it renders", () => {
		const patch = (sent[0] as { patch: Doc }).patch;
		expect(Object.keys(patch)).toEqual(["preview"]);
		expect(Object.keys(patch.preview as Doc).sort()).toEqual(["apiUrl", "url", "urls"]);
	});

	it("leaves the credentials and the limits alone", () => {
		expect(stored.testCredentials).toEqual(START.testCredentials);
		expect(stored.limits).toEqual(START.limits);
	});
});

// F1 of the ISS-1170 criterion-20 review: the form seeds from the environments document, so a
// read that has not landed or has failed must not present an editable form over an unread base.
describe("before the document is in hand", () => {
	it("offers no editable field while the read is in flight", async () => {
		const opened: { release: () => void } = { release: () => {} };
		held = new Promise<void>((resolve) => {
			opened.release = resolve;
		});
		draw(project());
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(screen.queryByLabelText(/environment limits/i)).toBeNull();
		opened.release();
		held = null;
		await screen.findByDisplayValue("https://preview.example");
	});

	it("says the read failed and offers it again, rather than a blank form", async () => {
		fails = true;
		draw(project());
		await screen.findByRole("button", { name: /retry/i });
		expect(screen.queryByLabelText(/environment limits/i)).toBeNull();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});

	it("keeps the page and every unsaved edit when a later read fails, and reads again on request", async () => {
		await mount();
		fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: "git@example.com:o/desk.git" } });
		fails = true;
		await act(async () => {
			await client.refetchQueries({ queryKey: ["project", "p1", "environments"] });
		});

		expect(await screen.findByTestId("environments-reread-failed")).toBeInTheDocument();
		expect(screen.getByLabelText("Repository URL")).toHaveValue("git@example.com:o/desk.git");
		expect(screen.getByDisplayValue("https://preview.example")).toBeInTheDocument();

		fails = false;
		fireEvent.click(screen.getByRole("button", { name: "Read again" }));
		await waitFor(() => expect(screen.queryByTestId("environments-reread-failed")).toBeNull());
		expect(screen.getByLabelText("Repository URL")).toHaveValue("git@example.com:o/desk.git");
	});
});

describe("a limits edit", () => {
	it("sends that key alone and leaves both deployment sides standing", async () => {
		await mount();
		fireEvent.change(screen.getByLabelText(/environment limits/i), {
			target: { value: "No issue ever rests at the release gate here." },
		});
		save();
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(Object.keys((sent[0] as { patch: Doc }).patch)).toEqual(["limits"]);
		expect(stored.preview).toEqual(START.preview);
		expect(stored.live).toEqual(START.live);
	});
});

describe("a value the page cannot accept", () => {
	it("names a malformed URL beside its field and sends nothing", async () => {
		await mount();
		fireEvent.change(screen.getByLabelText(/^live url/i), { target: { value: "not a url" } });
		await screen.findByText("Enter a valid URL (including http(s)://).");
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(sent).toEqual([]);
	});

	it("names a half-filled testing URL row, and stops naming it once the row is complete", async () => {
		await mount();
		fireEvent.change(screen.getByLabelText("Testing URL 1 label"), { target: { value: "" } });
		await screen.findByText("Label is required.");
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Testing URL 1 label"), { target: { value: "Mail" } });
		await waitFor(() => expect(screen.queryByText("Label is required.")).toBeNull());
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});
});

describe("the way out of a refused save", () => {
	const limits = () => screen.getByLabelText(/environment limits/i) as HTMLTextAreaElement;

	async function refused() {
		await mount();
		fireEvent.change(limits(), { target: { value: "mine" } });
		stored = { ...stored, limits: "theirs" };
		save();
		return screen.findByRole("button", { name: /use the current values/i });
	}

	it("takes what is stored now at the setting that moved, and says so", async () => {
		fireEvent.click(await refused());
		await waitFor(() => expect(limits().value).toBe("theirs"));
		expect(await screen.findByText(/loaded what is stored now/i)).toBeInTheDocument();
	});

	it("still takes it when a background read had already landed before the button was pressed", async () => {
		const button = await refused();
		await act(async () => {
			await client.refetchQueries({ queryKey: ["project", "p1", "environments"] });
			// The query cache hands a landed read to its observers on the next task.
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		fireEvent.click(button);
		await waitFor(() => expect(limits().value).toBe("theirs"));
		expect(await screen.findByText(/loaded what is stored now/i)).toBeInTheDocument();
	});
});

describe("a flat page", () => {
	it("stacks no card: its sections are flush with the page", async () => {
		await mount();
		expect(document.querySelectorAll("div.rounded-lg.border.bg-surface.shadow-sm")).toHaveLength(0);
	});
});

describe("a row typed only in part", () => {
	it("is an unsaved edit: Discard is offered, the leave warning is armed, and Save stays blocked", async () => {
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "Add URL" }));
		fireEvent.change(screen.getByLabelText("Testing URL 2 label"), { target: { value: "Admin" } });
		await screen.findByText("URL is required.");
		expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		const unload = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(unload);
		expect(unload.defaultPrevented).toBe(true);
	});

	it("is an unsaved edit for a credential with a password and no label", async () => {
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "Add credential" }));
		fireEvent.change(screen.getByLabelText("Credential 2 password"), { target: { value: "pw" } });
		await screen.findByText("Label is required.");
		expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
	});

	it("is not an edit while the added row is still blank", async () => {
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "Add URL" }));
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		const unload = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(unload);
		expect(unload.defaultPrevented).toBe(false);
	});
});

describe("the page's one Save", () => {
	it("is the only Save, disabled until a value moves and again once it is put back", async () => {
		await mount();
		expect(screen.getAllByRole("button", { name: /^save/i })).toHaveLength(1);
		const limits = screen.getByLabelText(/environment limits/i);
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		fireEvent.change(limits, { target: { value: "changed" } });
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
		fireEvent.change(limits, { target: { value: START.limits as string } });
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});
});

// ── The project's shape (ISS-1171) ──────────────────────────────────────────────────────────────

const radio = (name: RegExp) => screen.getByRole("radio", { name });

async function pick(name: RegExp) {
	fireEvent.click(radio(name));
	save();
	return screen.findByTestId("shape-confirm");
}

describe("the shape choice", () => {
	it("shows the stored shape as one of four", async () => {
		await mount(project());
		expect(screen.getAllByRole("radio")).toHaveLength(4);
		expect(radio(/publish to a live target/i)).toHaveAttribute("aria-checked", "true");
	});

	it("hides every repository and release-path field under No repository", async () => {
		await mount(project({ kind: "website", releaseChain: [] } as Partial<ProjectDetail>));
		expect(radio(/no repository/i)).toHaveAttribute("aria-checked", "true");
		for (const label of ["Repository path", "Repository URL", "Workspace setup", "Base branch"]) {
			expect(screen.queryByLabelText(label)).toBeNull();
		}
		expect(screen.queryByText("Release path")).toBeNull();
	});

	it("shows no promotion rows under Publish or under Repository, no release", async () => {
		await mount(project());
		expect(screen.queryByRole("button", { name: "Add a branch" })).toBeNull();
		expect(screen.queryByLabelText("2. Branch")).toBeNull();
		fireEvent.click(radio(/repository, no release/i));
		expect(screen.queryByText("Release path")).toBeNull();
		expect(screen.getByLabelText("Base branch")).toBeInTheDocument();
	});

	it("names a stored pair that fits no shape, and selects none", async () => {
		await mount(project({ kind: "website", releaseChain: [{ branch: "main" }] } as Partial<ProjectDetail>));
		expect(screen.getByRole("alert", { name: "" })).toBeDefined();
		expect(screen.getByText(/declared as having no repository/)).toBeInTheDocument();
		for (const r of screen.getAllByRole("radio")) expect(r).toHaveAttribute("aria-checked", "false");
	});

	it("disables the release path while no base branch is named, and says why", async () => {
		await mount(project({ releaseChain: [{ branch: "main" }, { branch: "live", from: "merge-branch" }] } as Partial<ProjectDetail>));
		fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "" } });
		expect(await screen.findByText(/Name the base branch under Repository first/)).toBeInTheDocument();
		expect(screen.getByLabelText("2. Branch")).toBeDisabled();
		expect(screen.getByRole("button", { name: "Add a branch" })).toBeDisabled();
	});
});

describe("saving a shape", () => {
	it("asks an ordinary confirmation where nothing is in flight, then stores kind website and an empty chain", async () => {
		await mount(project());
		const dialog = await pick(/no repository/i);
		expect(within(dialog).queryByLabelText(/type the project name/i)).toBeNull();
		fireEvent.click(within(dialog).getByRole("button", { name: "Change the shape" }));
		await waitFor(() => expect(projectSent).toHaveLength(1));
		expect(projectSent[0]).toEqual({ kind: "website", releaseChain: [] });
	});

	it("stores kind standard when a no-repository project picks a repository shape", async () => {
		await mount(project({ kind: "website", releaseChain: [] } as Partial<ProjectDetail>));
		fireEvent.click(within(await pick(/repository, no release/i)).getByRole("button", { name: "Change the shape" }));
		await waitFor(() => expect(projectSent).toHaveLength(1));
		expect(projectSent[0]).toEqual({ kind: "standard" });
	});

	it("asks for the project name while issues are in flight, and sends nothing until it is typed", async () => {
		counts = { in_progress: 1, testing: 1 };
		await mount(project());
		await waitFor(() => expect(screen.getByRole("radio", { name: /no repository/i })).toBeEnabled());
		const dialog = await pick(/repository, no release/i);
		expect(within(dialog).getByText("2 issues are started and not finished: 1 in progress and 1 in testing. The new shape decides how each one lands and is released.")).toBeInTheDocument();
		const confirm = within(dialog).getByRole("button", { name: "Change the shape" });
		expect(confirm).toBeDisabled();
		fireEvent.change(within(dialog).getByLabelText(/type the project name/i), { target: { value: "Des" } });
		expect(confirm).toBeDisabled();
		expect(projectSent).toEqual([]);
		fireEvent.change(within(dialog).getByLabelText(/type the project name/i), { target: { value: "Desk" } });
		fireEvent.click(confirm);
		await waitFor(() => expect(projectSent).toHaveLength(1));
		expect(projectSent[0]).toEqual({ releaseChain: [] });
	});

	it("asks no confirmation for an edit that keeps the shape", async () => {
		await mount(project());
		fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: "git@example.com:o/desk.git" } });
		save();
		await waitFor(() => expect(projectSent).toHaveLength(1));
		expect(screen.queryByTestId("shape-confirm")).toBeNull();
		expect(projectSent[0]).toEqual({ repoUrl: "git@example.com:o/desk.git" });
	});

	it("writes a promotion branch with the crossing chosen", async () => {
		await mount(project());
		fireEvent.click(radio(/promote through branches/i));
		fireEvent.click(screen.getByRole("button", { name: "Add a branch" }));
		fireEvent.change(screen.getByLabelText("2. Branch"), { target: { value: "production" } });
		save();
		fireEvent.click(within(await screen.findByTestId("shape-confirm")).getByRole("button", { name: "Change the shape" }));
		await waitFor(() => expect(projectSent).toHaveLength(1));
		expect(projectSent[0]).toEqual({
			releaseChain: [{ branch: "main" }, { branch: "production", from: "merge-branch" }],
		});
	});

	it("refuses Promote with no branch after the base, and sends nothing", async () => {
		await mount(project());
		fireEvent.click(radio(/promote through branches/i));
		expect(await screen.findByText(/Promote needs at least one branch/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});
});

describe("a save that would strand work", () => {
	it("says the chain refusal whole, writes nothing, and links to the waiting issues", async () => {
		projectRefusal = new ApiError(
			409,
			"RELEASE_CHAIN_STRANDS_WORK: this write empties the release chain while 1 of its issues waits.",
			"RELEASE_CHAIN_STRANDS_WORK",
			{ issues: ["ISS-3"], total: 1, status: "awaiting_release" },
		);
		await mount(project());
		fireEvent.click(within(await pick(/repository, no release/i)).getByRole("button", { name: "Change the shape" }));
		const banner = await screen.findByTestId("project-refusal");
		expect(banner).toHaveTextContent(
			"Nothing was saved. 1 issue waits at Awaiting release, and with no release path nothing would ever release it. Release it first, or return it to Developed, then save again.",
		);
		expect(banner.textContent).not.toMatch(/RELEASE_CHAIN_STRANDS_WORK|`|awaiting_release|\bthem\b/);
		// Said once: the banner, and no toast over it.
		expect(toast).not.toHaveBeenCalled();
		expect(within(banner).getByRole("link", { name: /open the 1 waiting issue/i })).toHaveAttribute(
			"href",
			"/projects/desk/issues?status=awaiting_release",
		);
		expect(radio(/repository, no release/i)).toHaveAttribute("aria-checked", "true");
	});

	it("links each issue a kind refusal names", async () => {
		projectRefusal = new ApiError(409, "PROJECT_KIND_STRANDS_WORK: marks would stop counting.", "PROJECT_KIND_STRANDS_WORK", {
			issues: ["ISS-4", "ISS-9"],
			total: 2,
			from: "standard",
			to: "website",
			landingShape: "git",
		});
		await mount(project());
		fireEvent.click(within(await pick(/no repository/i)).getByRole("button", { name: "Change the shape" }));
		const banner = await screen.findByTestId("project-refusal");
		expect(within(banner).getByRole("link", { name: "ISS-4" })).toHaveAttribute("href", "/projects/desk/issues/ISS-4");
		expect(within(banner).getByRole("link", { name: "ISS-9" })).toBeInTheDocument();
		expect(banner).toHaveTextContent(
			"2 unfinished issues carry merge marks that would stop counting as a landing once this project has no repository. Finish them first, then change the shape. Or keep their marks counting: on each issue, press Unmark, set Work lands to “In git”, and mark each one merged again; then change the shape.",
		);
		expect(banner.textContent).not.toMatch(/PROJECT_KIND_STRANDS_WORK|`|\/api\/|forge_issues|agent|no control|\bopen issue/);
		expect(toast).not.toHaveBeenCalled();
	});

	it("says a kind refusal toward a repository in the singular, pointing at the Work lands control to keep a CMS issue outside git", async () => {
		projectRefusal = new ApiError(409, "PROJECT_KIND_STRANDS_WORK: a mark would stop counting.", "PROJECT_KIND_STRANDS_WORK", {
			issues: ["ISS-4"],
			total: 1,
			from: "website",
			to: "standard",
			landingShape: "outside_git",
		});
		await mount(project({ kind: "website", releaseChain: [] } as Partial<ProjectDetail>));
		fireEvent.click(within(await pick(/repository, no release/i)).getByRole("button", { name: "Change the shape" }));
		const banner = await screen.findByTestId("project-refusal");
		expect(banner).toHaveTextContent(
			"1 unfinished issue carries a merge mark that would stop counting as a landing once this project has a repository. Finish it first, then change the shape. Or keep its mark counting: on the issue, press Unmark, set Work lands to “Outside git”, and mark it merged again; then change the shape.",
		);
		expect(banner.textContent).not.toMatch(/pull request|agent|no control/);
	});

	it("names issues waiting for release as waiting for release, never as under way", async () => {
		counts = { awaiting_release: 2 };
		await mount(project());
		await waitFor(() => expect(screen.getByRole("radio", { name: /no repository/i })).toBeEnabled());
		const dialog = await pick(/repository, no release/i);
		expect(dialog).toHaveTextContent(
			"2 issues are waiting for release, and the new shape decides how each one lands and is released.",
		);
		expect(dialog.textContent).not.toMatch(/under way/);
	});

	it("says the ordinary confirmation without calling anything under way", async () => {
		const dialog = await (async () => {
			await mount(project());
			return pick(/no repository/i);
		})();
		expect(dialog).toHaveTextContent("No issue is started and not finished, so nothing already started is re-routed.");
		expect(dialog.textContent).not.toMatch(/under way/);
	});

	it("shows a refusal under the shape it refuses, outside the sticky save bar", async () => {
		projectRefusal = new ApiError(409, "PROJECT_KIND_STRANDS_WORK: a mark would stop counting.", "PROJECT_KIND_STRANDS_WORK", {
			issues: ["ISS-4"],
			total: 1,
			from: "standard",
			to: "website",
			landingShape: "git",
		});
		await mount(project());
		fireEvent.click(within(await pick(/no repository/i)).getByRole("button", { name: "Change the shape" }));
		const banner = await screen.findByTestId("project-refusal");
		expect(banner.closest(".sticky")).toBeNull();
		const radios = screen.getByRole("radiogroup");
		expect(radios.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Environments" }).compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
	});

	it("says a failed environments save opens with nothing saved", async () => {
		envFailure = new ApiError(500, "", undefined);
		await mount();
		clear(/preview url/i);
		save();
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(
			await screen.findByText("Nothing was saved. The server ran into a problem and could not finish the request."),
		).toBeInTheDocument();
	});

	it("says what was saved where the project half landed and the environments half failed, in one banner", async () => {
		envFailure = new ApiError(500, "", undefined);
		await mount();
		fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: "git@example.com:o/desk.git" } });
		clear(/preview url/i);
		save();
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(
			await screen.findByText(
				"The shape and repository were saved; the environments were not. The server ran into a problem and could not finish the request.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/Nothing was saved/)).toBeNull();
	});

	it("says a save that landed once, in the tab's own name", async () => {
		await mount();
		clear(/preview url/i);
		save();
		await waitFor(() => expect(sent).toHaveLength(1));
		await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
		expect(toast).toHaveBeenCalledWith({ title: "Shape & release saved", tone: "success" });
	});

	it("tells a project that ships nothing that issues already wait at the release gate", async () => {
		counts = { awaiting_release: 2 };
		await mount(project({ releaseChain: [] } as Partial<ProjectDetail>));
		const notice = await screen.findByTestId("stranded-notice");
		expect(notice).toHaveTextContent(/2 issues wait at/);
		expect(within(notice).getByRole("link")).toHaveAttribute("href", "/projects/desk/issues?status=awaiting_release");
	});

	it("says nothing of the kind for a project that releases", async () => {
		counts = { awaiting_release: 2 };
		await mount(project());
		expect(screen.queryByTestId("stranded-notice")).toBeNull();
	});
});

describe("one save for the whole page", () => {
	it("writes a repository edit and an environment edit from the one bar", async () => {
		await mount(project());
		expect(screen.getAllByRole("button", { name: /^save/i })).toHaveLength(1);
		fireEvent.change(screen.getByLabelText("Workspace setup"), { target: { value: "pnpm i" } });
		fireEvent.change(screen.getByLabelText(/environment limits/i), { target: { value: "none" } });
		save();
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(projectSent).toEqual([{ workspaceSetup: "pnpm i" }]);
		expect(stored.limits).toBe("none");
	});
});
