// @vitest-environment jsdom
//
// ISS-1262: the Basics page is one form with one Save. What it sends is the field that moved, and a
// name the page cannot accept is named beside the field and sends nothing.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaveGuardProvider } from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { BasicsTab } from "./components/basics-tab";

expect.extend(matchers);

let sent: Array<Record<string, unknown>>;

vi.mock("@/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
	return {
		...actual,
		apiClient: async (_path: string, init?: { method?: string; body?: string }) => {
			if (init?.method === "PATCH") sent.push(JSON.parse(init.body ?? "{}"));
			return {};
		},
	};
});
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const PROJECT = { id: "p1", slug: "forge", name: "Forge", description: "The control plane." } as ProjectDetail;

function mount() {
	const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<LeaveGuardProvider>
				<BasicsTab project={PROJECT} canEdit />
			</LeaveGuardProvider>
		</QueryClientProvider>,
	);
}

const save = () => screen.getByRole("button", { name: "Save" });
const type = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
	sent = [];
});
afterEach(cleanup);

describe("the Basics page", () => {
	it("offers one Save, disabled until a value moves and again once it is put back", () => {
		mount();
		expect(screen.getAllByRole("button", { name: /^save/i })).toHaveLength(1);
		expect(save()).toBeDisabled();
		type("Name", "Forge 2");
		expect(save()).toBeEnabled();
		type("Name", "Forge");
		expect(save()).toBeDisabled();
	});

	it("sends the field that moved and nothing else", async () => {
		mount();
		type("Description", "  The control plane for agents.  ");
		fireEvent.click(save());
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({ description: "The control plane for agents." });
	});

	it("clears the description with null", async () => {
		mount();
		type("Description", "");
		fireEvent.click(save());
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({ description: null });
	});

	it("names a blank name beside the field and sends nothing", async () => {
		mount();
		type("Name", "   ");
		await screen.findByText("Name is required.");
		expect(save()).toBeDisabled();
		fireEvent.click(save());
		expect(sent).toEqual([]);
	});

	it("puts the page back to what was read when the person discards", async () => {
		mount();
		type("Name", "Forge 2");
		fireEvent.click(screen.getByRole("button", { name: "Discard" }));
		await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Forge"));
		expect(save()).toBeDisabled();
	});
});
