// REQ-80 BC-1, BC-2, BC-6: the Variables section. A holder of env.manage reads a plain value inline,
// sees a secret masked until it reveals that one row, writes at the version it read, and decides an
// agent's proposal with a reason. Anyone else reads key, scope and type, and is offered no value.
// @direct-test-of packages/web-v2/src/lib/i18n/copy/project-settings.json
// @direct-test-of packages/web-v2/src/features/project-settings/components/variable-form.tsx
// @direct-test-of packages/web-v2/src/features/project-settings/components/variable-proposals.tsx
// @direct-test-of packages/web-v2/src/features/project-settings/components/variable-labels.ts
// @direct-test-of packages/web-v2/src/features/project-settings/variables.ts

import type { VariableProposalView, VariableView } from "@forge/contracts/variables";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore } from "@/test/render";
import { VariablesSettings } from "./variables-section";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const P = "11111111-1111-4111-8111-111111111111";
const SECRET_ID = "22222222-2222-4222-8222-222222222222";
const PLAIN_ID = "33333333-3333-4333-8333-333333333333";
const PLANTED = "planted-reveal-value";

const row = (over: Partial<VariableView>): VariableView => ({
	id: SECRET_ID,
	key: "DATABASE_URL",
	environment: "production",
	type: "secret",
	protected: true,
	fingerprint: "0f0f0f0f0f0f0f0f",
	version: 3,
	value: null,
	updatedAt: "2026-10-30T00:00:00.000Z",
	updatedBy: null,
	...over,
});

const proposal: VariableProposalView = {
	id: "44444444-4444-4444-8444-444444444444",
	issueId: "55555555-5555-4555-8555-555555555555",
	act: "set",
	key: "LOG_LEVEL",
	environment: null,
	type: "plain",
	protected: false,
	fingerprint: "1a1a1a1a1a1a1a1a",
	status: "proposed",
	reason: "debug the flaky deploy",
	proposedBy: null,
	decidedBy: null,
	decisionReason: null,
	createdAt: "2026-10-30T00:00:00.000Z",
	decidedAt: null,
};

function core(canManage: boolean, proposals: VariableProposalView[] = []): Call[] {
	const variables = [
		row({}),
		row({ id: PLAIN_ID, key: "LOG_LEVEL", environment: null, type: "plain", protected: false, value: canManage ? "info" : null }),
	];
	return fakeCore((c) => {
		if (c.method === "GET" && c.path === `/projects/${P}/variables`)
			return { body: { variables, environments: [{ name: "production", tier: "production" }], canManage, proposalsWaiting: proposals.length } };
		if (c.method === "GET" && c.path === `/projects/${P}/variables/proposals`) return { body: { proposals } };
		if (c.method === "POST" && c.path === `/projects/${P}/variables/${SECRET_ID}/reveal`) return { body: { id: SECRET_ID, key: "DATABASE_URL", value: PLANTED } };
		if (c.method === "PUT" && c.path === `/projects/${P}/variables/${PLAIN_ID}`) return { body: row({ id: PLAIN_ID, key: "LOG_LEVEL", version: 4 }) };
		if (c.method === "POST" && c.path.endsWith("/decision")) return { body: { ...proposal, status: "rejected" } };
		return undefined;
	});
}

function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<VariablesSettings projectId={P} />
		</QueryClientProvider>,
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("the Variables section", () => {
	it("shows a manager the plain value inline and a secret masked until that row is revealed", async () => {
		const calls = core(true);
		mount();
		const rows = await screen.findAllByTestId("variable-row");
		expect(within(rows[1]).getByText("info")).toBeInTheDocument();
		expect(screen.queryByText(PLANTED)).toBeNull();
		expect(calls.some((c) => c.path.endsWith("/reveal"))).toBe(false);
		fireEvent.click(within(rows[0]).getByRole("button", { name: "Reveal" }));
		expect(await screen.findByTestId("revealed-value")).toHaveTextContent(PLANTED);
		fireEvent.click(screen.getByRole("button", { name: "Hide value" }));
		expect(screen.queryByText(PLANTED)).toBeNull();
	});

	it("offers a reader without env.manage names only: no value, no reveal, no write", async () => {
		const calls = core(false);
		mount();
		const rows = await screen.findAllByTestId("variable-row");
		expect(rows).toHaveLength(2);
		expect(screen.getByText("DATABASE_URL")).toBeInTheDocument();
		expect(screen.queryByText("info")).toBeNull();
		expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Add variable" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Edit LOG_LEVEL" })).toBeNull();
		expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
	});

	it("writes an edit at the version it read, and a blank value keeps the stored one", async () => {
		const calls = core(true);
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Edit LOG_LEVEL" }));
		fireEvent.click(screen.getByRole("button", { name: "Save variable" }));
		await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeDefined());
		const body = calls.find((c) => c.method === "PUT")?.body as Record<string, unknown>;
		expect(body).toMatchObject({ baseVersion: 3, type: "plain", protected: false });
		expect(body).not.toHaveProperty("value");
	});

	it("refuses a key that is not a variable name before anything is sent", async () => {
		const calls = core(true);
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Add variable" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Key" }), { target: { value: "9-bad" } });
		expect(screen.getByText("Letters, digits and underscores; not starting with a digit")).toBeInTheDocument();
		expect(within(screen.getByTestId("variable-form")).getByRole("button", { name: "Add variable" })).toBeDisabled();
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
	});

	it("decides an agent's proposal only with a reason, and sends that reason", async () => {
		const calls = core(true, [proposal]);
		mount();
		const table = await screen.findByTestId("variable-proposals");
		const reject = within(table).getByRole("button", { name: "Reject" });
		expect(reject).toBeDisabled();
		fireEvent.change(screen.getByRole("textbox", { name: "Reason for the decision" }), { target: { value: "not on prod" } });
		fireEvent.click(reject);
		await waitFor(() => expect(calls.find((c) => c.path.endsWith("/decision"))).toBeDefined());
		expect(calls.find((c) => c.path.endsWith("/decision"))?.body).toEqual({ decision: "reject", reason: "not on prod" });
	});
});
