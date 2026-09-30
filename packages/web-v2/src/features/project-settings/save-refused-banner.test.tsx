// @vitest-environment jsdom
//
// ISS-1170: the refusal banner's two ways out of an `ENVIRONMENTS_STALE` save. Each re-reads the
// environments document; only "Use the current values" yields the paths that moved.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { SaveRefusedBanner } from "./components/save-refused-banner";

expect.extend(matchers);

afterEach(cleanup);

const stale = new ApiError(409, "the environments settings changed", "ENVIRONMENTS_STALE", {
	conflicts: [{ path: "live.url", base: "https://a", stored: "https://b" }],
});

function mount() {
	const qc = new QueryClient();
	const invalidate = vi.spyOn(qc, "invalidateQueries");
	const draft = { takeStored: vi.fn(), replaced: [], dismissReplaced: vi.fn() };
	render(
		<QueryClientProvider client={qc}>
			<SaveRefusedBanner projectId="p1" error={stale} draft={draft} />
		</QueryClientProvider>,
	);
	return { draft, invalidate };
}

describe("a refused environments save", () => {
	it("names the setting that moved and that nothing was saved", () => {
		mount();
		expect(screen.getByText(/Live was changed by someone else/)).toBeInTheDocument();
		expect(screen.getByText(/Nothing was saved/)).toBeInTheDocument();
	});

	it("takes the stored value at the moved path and re-reads the environments document", () => {
		const { draft, invalidate } = mount();
		fireEvent.click(screen.getByRole("button", { name: /use the current values/i }));
		expect(draft.takeStored).toHaveBeenCalledWith(["live.url"]);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["project", "p1", "environments"] });
	});

	it("keeps the typed value and re-reads, yielding nothing", () => {
		const { draft } = mount();
		fireEvent.click(screen.getByRole("button", { name: /keep my changes/i }));
		expect(draft.takeStored).toHaveBeenCalledWith([]);
	});
});
