// @vitest-environment jsdom
//
// The environments half of ISS-1170. The Testing tab renders three of the preview side's keys
// and none of the others, so clearing those three may null neither the preview object nor any
// key the form never showed. What is asserted is the STORED document after a save, through the
// server's own contract.

import { applyDocumentPatch, comparePatchBase } from "@forge/contracts/document-patch";
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { TestingTab } from "./components/testing-tab";

expect.extend(matchers);

type Doc = Record<string, unknown>;

let stored: Doc;
let sent: unknown[];
/** Held open, or made to fail, by the cases about a read that has not landed. */
let held: Promise<void> | null;
let fails: boolean;

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
	const view = render(
		<QueryClientProvider client={qc}>
			<TestingTab projectId="p1" canEdit />
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
	fireEvent.click(screen.getByRole("button", { name: /save testing config/i }));
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
				<TestingTab projectId="p1" canEdit />
			</QueryClientProvider>,
		);
		expect(screen.queryByRole("button", { name: /save testing config/i })).toBeNull();
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
				<TestingTab projectId="p1" canEdit />
			</QueryClientProvider>,
		);
		await screen.findByRole("button", { name: /retry/i });
		expect(screen.queryByLabelText(/environment limits/i)).toBeNull();
		expect(screen.queryByRole("button", { name: /save testing config/i })).toBeNull();
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
