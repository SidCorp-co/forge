// @vitest-environment jsdom
//
// The environments half of ISS-1170. The Testing tab renders three of the preview side's keys
// and none of the others, so clearing those three may null neither the preview object nor any
// key the form never showed. What is asserted is the STORED document after a save, through the
// server's own contract.

import { applyDocumentPatch, comparePatchBase } from "@forge/contracts/document-patch";
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaveGuardProvider } from "@/design";
import { ApiError } from "@/lib/api/client";
import { TestingTab } from "./components/testing-tab";

expect.extend(matchers);

type Doc = Record<string, unknown>;

let stored: Doc;
let sent: unknown[];
/** Held open, or made to fail, by the cases about a read that has not landed. */
let held: Promise<void> | null;
let fails: boolean;
let client: QueryClient;

vi.mock("@/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
	return {
		...actual,
		apiClient: async (path: string, init?: { method?: string; body?: string }) => {
			if (path.endsWith("/environments") && init?.method === "PATCH") {
				const write = JSON.parse(init.body ?? "null") as { base: Doc; patch: Doc };
				sent.push(write);
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
			throw new Error(`unmocked ${init?.method ?? "GET"} ${path}`);
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

async function mount() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client = qc;
	const view = render(
		<QueryClientProvider client={qc}>
			<LeaveGuardProvider>
					<TestingTab projectId="p1" canEdit />
				</LeaveGuardProvider>
		</QueryClientProvider>,
	);
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
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<LeaveGuardProvider>
					<TestingTab projectId="p1" canEdit />
				</LeaveGuardProvider>
			</QueryClientProvider>,
		);
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(screen.queryByLabelText(/environment limits/i)).toBeNull();
		opened.release();
		held = null;
		await screen.findByDisplayValue("https://preview.example");
	});

	it("says the read failed and offers it again, rather than a blank form", async () => {
		fails = true;
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<LeaveGuardProvider>
					<TestingTab projectId="p1" canEdit />
				</LeaveGuardProvider>
			</QueryClientProvider>,
		);
		await screen.findByRole("button", { name: /retry/i });
		expect(screen.queryByLabelText(/environment limits/i)).toBeNull();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
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
