// @vitest-environment jsdom
//
// ISS-5: the policy is the one document dispatch reads, so its editor owes three things — say
// when there is none, send the whole document against the revision it read, and show each
// refusal core named rather than a bare "failed".

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicySection } from "./components/policy-section";

expect.extend(matchers);

type Doc = Record<string, unknown>;

let stored: { revision: number; document: Doc } | null;
let sent: Array<{ baseRevision: number | null; document: Doc }>;
let refuseWith: Array<{ code: string; path: string; detail: string }> | null;

vi.mock("@/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
	return {
		...actual,
		apiClient: async (path: string, init?: { method?: string; body?: string }) => {
			if (!path.endsWith("/policy")) throw new Error(`unmocked ${init?.method ?? "GET"} ${path}`);
			if (init?.method === "PUT") {
				const write = JSON.parse(init.body ?? "null");
				sent.push(write);
				if (refuseWith) {
					const error = { code: "CONFIG_REFUSED", message: "refused, nothing written", refusals: refuseWith };
					throw new actual.ApiError(422, "Unprocessable Entity", undefined, undefined, { error });
				}
				stored = { revision: (stored?.revision ?? 0) + 1, document: write.document };
				return {
					declared: true,
					...stored,
					updatedBy: "u1",
					updatedAt: "2026-10-01T00:00:00.000Z",
					created: true,
				};
			}
			if (!stored) return { declared: false, revision: null, document: null };
			return { declared: true, ...stored, updatedBy: "u1", updatedAt: "2026-10-01T00:00:00.000Z" };
		},
	};
});

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

const POLICY: Doc = {
	version: 1,
	qa: "self",
	intake: { mode: "auto" },
	permissions: { driver: { deny: ["CronCreate"] } },
	states: { open: { model: "opus", permissions: "driver" } },
};

function mount() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<PolicySection projectId="p1" canEdit />
		</QueryClientProvider>,
	);
}

const editor = () => screen.getByLabelText("Policy document (JSON)") as HTMLTextAreaElement;

function type(doc: unknown) {
	fireEvent.change(editor(), {
		target: { value: typeof doc === "string" ? doc : JSON.stringify(doc, null, 2) },
	});
}

beforeEach(() => {
	stored = { revision: 3, document: structuredClone(POLICY) };
	sent = [];
	refuseWith = null;
	toast.mockClear();
});
afterEach(cleanup);

describe("the policy editor", () => {
	it("says nothing dispatches where the project has no policy", async () => {
		stored = null;
		mount();
		expect(await screen.findByText(/No policy — nothing dispatches for this project/)).toBeInTheDocument();
	});

	it("sends the whole document against the revision it read", async () => {
		mount();
		await waitFor(() => expect(editor().value).toContain('"qa": "self"'));
		const next = { ...POLICY, qa: "independent" };
		type(next);
		fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({ baseRevision: 3, document: next });
		expect(await screen.findByText("Revision 4")).toBeInTheDocument();
	});

	it("lists each refusal by its code and path", async () => {
		refuseWith = [
			{
				code: "TOOL_PATTERN_INVALID",
				path: "/permissions/driver/deny/0",
				detail: '"bash" is not a tool pattern',
			},
		];
		mount();
		await waitFor(() => expect(editor().value).toContain("CronCreate"));
		type({ ...POLICY, permissions: { driver: { deny: ["bash"] } } });
		fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

		const code = await screen.findByText("TOOL_PATTERN_INVALID");
		expect(code.closest("li")?.textContent).toContain("/permissions/driver/deny/0");
		expect(code.closest("li")?.textContent).toContain("is not a tool pattern");
		expect(screen.getByText(/Refused, nothing written/)).toBeInTheDocument();
	});

	it("refuses text that is not JSON before sending anything", async () => {
		mount();
		await waitFor(() => expect(editor().value).toContain("CronCreate"));
		type('{ "version": 1,');
		fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

		expect(await screen.findByText(/Not valid JSON/)).toBeInTheDocument();
		expect(screen.getByText(/Nothing was sent/)).toBeInTheDocument();
		expect(sent).toHaveLength(0);
	});

});
