// @vitest-environment jsdom
//
// The tab's job is to draw the state the SERVER reports and to send exactly the
// call each button owns. Every case asserts the rendered numbers against the
// mocked payload — a tab that computes its own totals would pass a looser test
// and lie the moment the job's arithmetic changed.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "@/features/projects/types";
import { ApiError } from "@/lib/api/client";
import { MemoryTab } from "./components/memory-tab";
import { isReindexLive } from "./hooks";
import type { MemoryModelStatus, MemoryReindex, MemoryReindexEstimate } from "./types";

expect.extend(matchers);
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const statusQ = vi.fn();
const estimateQ = vi.fn();
const setMutate = vi.fn();
const cancelMutate = vi.fn();
vi.mock("./hooks", async () => {
	const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
	return {
		...actual,
		useMemoryModel: () => statusQ(),
		useMemoryEstimate: () => estimateQ(),
		useSetMemoryModel: () => ({ mutate: setMutate, isPending: false }),
		useCancelMemoryReindex: () => ({ mutate: cancelMutate, isPending: false }),
	};
});

const project = { id: "p1", name: "Forge Dev", slug: "forge-dev" } as unknown as ProjectDetail;
const ESTIMATE: MemoryReindexEstimate = {
	memories: 658,
	totalChars: 1634855,
	estimatedChunks: 1882,
	estimatedEmbedCalls: 658,
	estimatedMinutes: 7,
};
const REINDEX: MemoryReindex = {
	state: "running",
	total: 658,
	done: 250,
	remaining: 408,
	requestedAt: "2026-09-04T10:00:00.000Z",
	startedAt: "2026-09-04T10:00:01.000Z",
	lastBatchAt: "2026-09-04T10:03:00.000Z",
};
const ok = (data: unknown) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });

function renderWith(status: MemoryModelStatus, canEdit = true) {
	statusQ.mockReturnValue(ok(status));
	estimateQ.mockReturnValue(ok(ESTIMATE));
	return render(<MemoryTab project={project} canEdit={canEdit} />);
}

describe("MemoryTab · flat", () => {
	it("shows the estimate's five numbers as returned and the confirm button", () => {
		renderWith({ model: "flat", reindex: null });
		const dl = screen.getByTestId("memory-estimate");
		for (const v of ["658", "1,634,855", "1,882", "7"]) expect(dl).toHaveTextContent(v);
		expect(screen.getByText("flat")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Switch to chunked" })).toBeEnabled();
	});

	it("confirm sends POST { model: 'chunked' } once", () => {
		renderWith({ model: "flat", reindex: null });
		fireEvent.click(screen.getByRole("button", { name: "Switch to chunked" }));
		expect(setMutate).toHaveBeenCalledTimes(1);
		expect(setMutate.mock.calls[0]?.[0]).toBe("chunked");
	});

	// cm:guard the 409 is a sentence and a refetch, never a retry: the mutate mock reports the conflict and the test counts exactly one call
	it("a 409 renders 'A reindex is already running.' and sends no second POST", () => {
		setMutate.mockImplementation((_m, opts) =>
			opts?.onError?.(new ApiError(409, "a reindex is already queued or running", "REINDEX_LIVE")),
		);
		renderWith({ model: "flat", reindex: null });
		fireEvent.click(screen.getByRole("button", { name: "Switch to chunked" }));
		expect(screen.getByText("A reindex is already running.")).toBeInTheDocument();
		expect(setMutate).toHaveBeenCalledTimes(1);
	});

	it("a non-admin sees the estimate and no button", () => {
		renderWith({ model: "flat", reindex: null }, false);
		expect(screen.getByTestId("memory-estimate")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("MemoryTab · queued / running", () => {
	it("shows done / total, remaining, the progress value and last batch time, with Cancel", () => {
		renderWith({ model: "chunked", reindex: REINDEX });
		const counts = screen.getByTestId("memory-reindex-counts");
		expect(counts).toHaveTextContent("250 / 658");
		expect(counts).toHaveTextContent("408");
		expect(counts).toHaveTextContent(new Date(REINDEX.lastBatchAt as string).toLocaleString());
		expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "38");
		expect(screen.getByText("running")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
	});

	it("queued draws an indeterminate bar and a dash for the batch time", () => {
		renderWith({ model: "chunked", reindex: { ...REINDEX, state: "queued", done: 0, remaining: 658, lastBatchAt: undefined } });
		expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
		expect(screen.getByTestId("memory-reindex-counts")).toHaveTextContent("—");
	});

	it("Cancel sends DELETE once", () => {
		renderWith({ model: "chunked", reindex: REINDEX });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(cancelMutate).toHaveBeenCalledTimes(1);
		expect(setMutate).not.toHaveBeenCalled();
	});

	it("a non-admin sees the counts and no Cancel", () => {
		renderWith({ model: "chunked", reindex: REINDEX }, false);
		expect(screen.getByTestId("memory-reindex-counts")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("polls only while queued or running", () => {
		expect(isReindexLive({ model: "chunked", reindex: { ...REINDEX, state: "queued" } })).toBe(true);
		expect(isReindexLive({ model: "chunked", reindex: REINDEX })).toBe(true);
		for (const state of ["completed", "failed", "cancelled"] as const) {
			expect(isReindexLive({ model: "chunked", reindex: { ...REINDEX, state } })).toBe(false);
		}
		expect(isReindexLive({ model: "flat", reindex: null })).toBe(false);
		expect(isReindexLive(undefined)).toBe(false);
	});
});

describe("MemoryTab · failed / cancelled / completed", () => {
	it("failed shows lastError verbatim and Retry re-POSTs chunked", () => {
		renderWith({
			model: "chunked",
			reindex: { ...REINDEX, state: "failed", done: 100, remaining: 558, lastError: "embeddings outage (503)" },
		});
		expect(screen.getByText("embeddings outage (503)")).toBeInTheDocument();
		expect(screen.getByTestId("memory-reindex-counts")).toHaveTextContent("100 / 658");
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(setMutate).toHaveBeenCalledTimes(1);
		expect(setMutate.mock.calls[0]?.[0]).toBe("chunked");
	});

	it("cancelled shows done / total and Resume re-POSTs chunked", () => {
		renderWith({ model: "chunked", reindex: { ...REINDEX, state: "cancelled", done: 50, remaining: 608 } });
		expect(screen.getByTestId("memory-reindex-counts")).toHaveTextContent("50 / 658");
		fireEvent.click(screen.getByRole("button", { name: "Resume" }));
		expect(setMutate).toHaveBeenCalledTimes(1);
		expect(setMutate.mock.calls[0]?.[0]).toBe("chunked");
	});

	it("completed offers the flat switch behind a type-to-confirm naming the seven-day purge", () => {
		renderWith({ model: "chunked", reindex: { ...REINDEX, state: "completed", done: 658, remaining: 0 } });
		expect(screen.getByText("chunked")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Switch back to flat" }));
		expect(screen.getByText(/kept for seven\s+days/i)).toBeInTheDocument();
		const confirm = screen.getByRole("button", { name: "Confirm switch to flat" });
		expect(confirm).toBeDisabled();
		fireEvent.change(screen.getByLabelText(/Type the project name to confirm/i), { target: { value: "wrong" } });
		expect(confirm).toBeDisabled();
		fireEvent.change(screen.getByLabelText(/Type the project name to confirm/i), { target: { value: "Forge Dev" } });
		expect(confirm).toBeEnabled();
		fireEvent.click(confirm);
		expect(setMutate).toHaveBeenCalledTimes(1);
		expect(setMutate.mock.calls[0]?.[0]).toBe("flat");
	});

	it("completed with no reindex record (a project chunked before any job) still reads chunked, read-only for a member", () => {
		renderWith({ model: "chunked", reindex: null }, false);
		expect(screen.getByText("chunked")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("MemoryTab · loading and error", () => {
	it("renders a skeleton while the state loads", () => {
		statusQ.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
		estimateQ.mockReturnValue(ok(undefined));
		const { container } = render(<MemoryTab project={project} canEdit />);
		expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
	});

	it("renders a retryable error rather than nothing", () => {
		statusQ.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("boom"), refetch: vi.fn() });
		estimateQ.mockReturnValue(ok(undefined));
		render(<MemoryTab project={project} canEdit />);
		expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
	});
});
