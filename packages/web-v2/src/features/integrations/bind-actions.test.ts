import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	bindingDocument: vi.fn(),
	putBindingDocument: vi.fn(),
	update: vi.fn(),
	createConnection: vi.fn(),
	removeConnection: vi.fn(),
}));

vi.mock("./api", () => ({
	integrationsApi: {
		list: api.list,
		bindingDocument: api.bindingDocument,
		putBindingDocument: api.putBindingDocument,
		update: api.update,
	},
	integrationConnectionsApi: { create: api.createConnection, remove: api.removeConnection },
}));

const { bindConnection, createIntegration, updateIntegration } = await import("./bind-actions");

const PROJECT = "p1";
const BINDING = "8b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e";
const APP = { label: "primary", resourceUuid: "y8w4c4kss8ogo8gc44ow44kc" };

function summary(over: Record<string, unknown> = {}) {
	return {
		id: BINDING,
		connectionId: "c1",
		provider: "coolify",
		role: "deploy",
		label: "",
		bindingActive: true,
		agentAccess: "none",
		bindingConfig: { targets: [{ id: "primary", ...APP }], releaseRunnerLabel: "release" },
		...over,
	};
}

const coolifyDoc = (target: Record<string, unknown>) => ({
	$schema: "https://forge.sidcorp.co/schemas/binding-v1.json",
	version: 1,
	id: BINDING,
	role: "deploy",
	connection: "c1",
	agentAccess: "none",
	target: { provider: "coolify", ...target },
});

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.list.mockResolvedValue({ items: [summary()] });
	api.createConnection.mockResolvedValue({ connection: { id: "c-new" } });
	api.putBindingDocument.mockResolvedValue({ declared: true, revision: 1 });
	api.removeConnection.mockResolvedValue({ ok: true });
});

describe("connecting a provider", () => {
	it("creates the connection from its own tier and binds it with a binding document", async () => {
		api.list.mockResolvedValue({ items: [] });
		await createIntegration(PROJECT, {
			provider: "coolify",
			role: "deploy",
			config: { baseUrl: "https://coolify.x", targets: [APP], releaseRunnerLabel: "release" },
			secrets: { apiToken: "tok-12345678" },
		});
		expect(api.createConnection).toHaveBeenCalledWith({
			provider: "coolify",
			config: { baseUrl: "https://coolify.x" },
			secrets: { apiToken: "tok-12345678" },
		});
		const [project, id, write] = api.putBindingDocument.mock.calls[0];
		expect(project).toBe(PROJECT);
		expect(write).toEqual({
			baseRevision: null,
			document: expect.objectContaining({
				id,
				role: "deploy",
				connection: "c-new",
				agentAccess: "none",
				active: true,
				target: { provider: "coolify", applications: [APP], releaseRunnerLabel: "release" },
			}),
		});
	});

	it("removes the connection it made when the binding is refused, and rethrows the refusal", async () => {
		api.list.mockResolvedValue({ items: [] });
		const refused = new Error("refused");
		api.putBindingDocument.mockRejectedValue(refused);
		await expect(
			createIntegration(PROJECT, { provider: "sentry", role: "service", config: {} }),
		).rejects.toBe(refused);
		expect(api.removeConnection).toHaveBeenCalledWith("c-new");
	});

	it("writes a switched-off service slot back on at its revision rather than colliding with it", async () => {
		api.list.mockResolvedValue({
			items: [summary({ provider: "github", role: "service", bindingActive: false })],
		});
		api.bindingDocument.mockResolvedValue({ declared: true, revision: 4, document: coolifyDoc({}) });
		await bindConnection(PROJECT, {
			connectionId: "c2",
			provider: "github",
			role: "service",
			binding: { owner: "acme", repo: "shop", installationId: 7 },
		});
		const [, id, write] = api.putBindingDocument.mock.calls[0];
		expect(id).toBe(BINDING);
		expect(write.baseRevision).toBe(4);
		expect(write.document.active).toBe(true);
		expect(write.document.connection).toBe("c2");
		expect(write.document.target).toEqual({
			provider: "github",
			owner: "acme",
			repo: "shop",
			installationId: 7,
		});
	});
});

describe("editing a binding", () => {
	it("clears the release runner label through the document at the revision it read", async () => {
		api.bindingDocument.mockResolvedValue({
			declared: true,
			revision: 3,
			document: coolifyDoc({ applications: [APP], releaseRunnerLabel: "release" }),
		});
		await updateIntegration(PROJECT, BINDING, { config: { releaseRunnerLabel: null } });
		expect(api.putBindingDocument).toHaveBeenCalledWith(PROJECT, BINDING, {
			baseRevision: 3,
			document: { ...coolifyDoc({ applications: [APP] }), active: true },
		});
		expect(api.update).not.toHaveBeenCalled();
	});

	it("writes an agent grant through the document, and nothing through the integrations PATCH", async () => {
		api.bindingDocument.mockResolvedValue({
			declared: true,
			revision: 3,
			document: coolifyDoc({ applications: [APP] }),
		});
		await updateIntegration(PROJECT, BINDING, { agentAccess: "all" });
		expect(api.putBindingDocument.mock.calls[0][2].document.agentAccess).toBe("all");
		expect(api.update).not.toHaveBeenCalled();
	});

	it("sends secrets and a connection-tier key to the integrations PATCH only", async () => {
		await updateIntegration(PROJECT, BINDING, {
			config: { baseUrl: "https://coolify.y" },
			secrets: { apiToken: "tok-87654321" },
		});
		expect(api.putBindingDocument).not.toHaveBeenCalled();
		expect(api.update).toHaveBeenCalledWith(PROJECT, BINDING, {
			config: { baseUrl: "https://coolify.y" },
			secrets: { apiToken: "tok-87654321" },
		});
	});

	it("switches a binding off and back on through its document at the revision it read", async () => {
		api.bindingDocument.mockResolvedValue({
			declared: true,
			revision: 3,
			document: { ...coolifyDoc({ applications: [APP] }), active: true },
		});
		await updateIntegration(PROJECT, BINDING, { active: false });
		expect(api.putBindingDocument).toHaveBeenCalledWith(PROJECT, BINDING, {
			baseRevision: 3,
			document: { ...coolifyDoc({ applications: [APP] }), active: false },
		});

		api.bindingDocument.mockResolvedValue({
			declared: true,
			revision: 4,
			document: { ...coolifyDoc({ applications: [APP] }), active: false },
		});
		await updateIntegration(PROJECT, BINDING, { active: true });
		expect(api.putBindingDocument.mock.calls[1]?.[2]).toEqual({
			baseRevision: 4,
			document: { ...coolifyDoc({ applications: [APP] }), active: true },
		});
		expect(api.update).not.toHaveBeenCalled();
	});

	it("sets instructions through the document, and drops the key to clear them", async () => {
		api.bindingDocument.mockResolvedValue({
			declared: true,
			revision: 3,
			document: { ...coolifyDoc({ applications: [APP] }), instructions: "deploy at night" },
		});
		await updateIntegration(PROJECT, BINDING, { instructions: "deploy at noon" });
		expect(api.putBindingDocument.mock.calls[0]?.[2].document.instructions).toBe("deploy at noon");
		await updateIntegration(PROJECT, BINDING, { instructions: null });
		expect(api.putBindingDocument.mock.calls[1]?.[2].document).not.toHaveProperty("instructions");
		expect(api.update).not.toHaveBeenCalled();
	});
});
