// @vitest-environment jsdom
//
// A binding written from the integrations surface changes the same panels as one written from the
// config tab: the effective config, the environment state and release readiness all read it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/features/projects/hooks", () => ({ useProjects: () => ({ data: [] }) }));
vi.mock("@/features/orgs/hooks", () => ({ useOrgs: () => ({ data: [] }) }));
vi.mock("./bind-actions", () => ({
	bindConnection: vi.fn(async () => ({ revision: 1 })),
	createIntegration: vi.fn(async () => ({ revision: 1 })),
	updateIntegration: vi.fn(async () => ({ revision: 1 })),
	bindingRefusalText: () => "",
}));
vi.mock("./api", () => ({
	integrationsApi: { remove: vi.fn(async () => ({ ok: true })) },
	integrationConnectionsApi: {},
}));
vi.mock("@/features/project-settings/config-api", () => ({
	configApi: {
		putBinding: vi.fn(async () => ({ revision: 2 })),
		putProjectDocument: vi.fn(async () => ({ revision: 2 })),
	},
}));

const hooks = await import("./hooks");
const { useWriteBinding, useWriteProjectDocument } = await import(
	"@/features/project-settings/config-hooks"
);

const P = "p1";
const BINDING_PANELS = [
	["project", P, "bindings"],
	["project", P, "config-effective"],
	["project", P, "environment-state"],
	["project", P, "release-readiness"],
];

function harness() {
	const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	const invalidated = vi.spyOn(qc, "invalidateQueries");
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	const keys = () => invalidated.mock.calls.map(([f]) => f?.queryKey);
	return { wrapper, keys };
}

afterEach(cleanup);

const WRITES: Array<[string, () => { mutate: (v: never) => void; isSuccess: boolean }, unknown]> = [
	["useBindConnection", () => hooks.useBindConnection(P), { connectionId: "c1" }],
	["useCreateProviderIntegration", () => hooks.useCreateProviderIntegration(P), { provider: "coolify" }],
	["useUpdateProviderIntegration", () => hooks.useUpdateProviderIntegration(P), { id: "b1", body: {} }],
	["useDeleteProviderIntegration", () => hooks.useDeleteProviderIntegration(P), { id: "b1", revision: 3 }],
	["useWriteBinding (config tab)", () => useWriteBinding(P, "b1"), { base: 1, document: {} }],
];

describe("a binding write refreshes every panel that reads the binding", () => {
	it.each(WRITES)("%s", async (_name, use, input) => {
		const { wrapper, keys } = harness();
		const { result } = renderHook(use, { wrapper });
		act(() => result.current.mutate(input as never));
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		for (const key of BINDING_PANELS) expect(keys()).toContainEqual(key);
	});
});

describe("a project document write refreshes the project row it projects", () => {
	it("invalidates the project detail and the console list, where the slug and name are read", async () => {
		const { wrapper, keys } = harness();
		const { result } = renderHook(() => useWriteProjectDocument(P), { wrapper });
		act(() => result.current.mutate({ baseRevision: 1, document: {} }));
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(keys()).toContainEqual(["project", P]);
		expect(keys()).toContainEqual(["projects"]);
	});
});
