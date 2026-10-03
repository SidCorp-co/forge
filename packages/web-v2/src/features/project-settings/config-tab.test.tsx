// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

type Doc = Record<string, unknown>;
type Held = { revision: number; document: Doc };
type Refusal = { code: string; path: string; detail: string };

let stored: Record<string, Held | null>;
let sent: Array<{ path: string; baseRevision: number | null; document: Doc }>;
let refuseWith: Refusal[] | null;
let reads: Record<string, () => unknown>;
let secretWrites: Array<{ path: string; body: unknown }>;

const STALE: Refusal = {
	code: "STALE_BASE",
	path: "/baseRevision",
	detail: "this write was based on an older revision. Read it again and reapply the change; nothing was written.",
};

vi.mock("@/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
	const refuse = (refusals: Refusal[]) => {
		const error = { code: "CONFIG_REFUSED", message: "refused, nothing written", refusals };
		return new actual.ApiError(422, "Unprocessable Entity", undefined, undefined, { error });
	};
	return {
		...actual,
		apiClient: async (path: string, init?: { method?: string; body?: string }) => {
			if (init?.method === "PUT" && path.includes("/secrets/")) {
				secretWrites.push({ path, body: JSON.parse(init.body ?? "null") });
				const [scope, name] = path.split("/").slice(-2);
				return { ref: `secret://${scope}/${name}`, scope, name, updatedAt: "2026-10-01T00:00:00.000Z" };
			}
			if (init?.method === "PUT") {
				const write = JSON.parse(init.body ?? "null");
				sent.push({ path, ...write });
				const held = stored[path] ?? null;
				if ((held?.revision ?? null) !== write.baseRevision) throw refuse([STALE]);
				if (refuseWith) throw refuse(refuseWith);
				stored[path] = { revision: (held?.revision ?? 0) + 1, document: write.document };
				return { declared: true, ...stored[path], created: !held };
			}
			const read = reads[path];
			if (read) return read();
			if (!(path in stored)) throw new Error(`unmocked ${init?.method ?? "GET"} ${path}`);
			const held = stored[path];
			return held ? { declared: true, ...held } : { declared: false, revision: null, document: null };
		},
	};
});

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

const { PolicyDocumentSection, TestingProfilesSection } = await import("./components/config-documents");
const { EffectiveSection, EnvironmentStateSection } = await import("./components/config-readings");
const { SecretsSection } = await import("./components/secrets-section");
const { ApiError } = await import("@/lib/api/client");

const POLICY_PATH = "/projects/p1/policy";
const POLICY: Doc = {
	$schema: "https://forge.sidcorp.co/schemas/policy-v1.json",
	version: 1,
	qa: "self",
	intake: { mode: "auto" },
	permissions: { driver: { deny: ["CronCreate"] } },
	states: { open: { model: "opus", permissions: "driver" } },
};

function draw(node: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const otherWriter = (patch: (doc: Doc) => Doc) => {
	const held = stored[POLICY_PATH] as Held;
	stored[POLICY_PATH] = { revision: held.revision + 1, document: patch(held.document) };
};

beforeEach(() => {
	stored = { [POLICY_PATH]: { revision: 1, document: POLICY } };
	sent = [];
	refuseWith = null;
	reads = {};
	secretWrites = [];
	toast.mockClear();
});

afterEach(cleanup);

describe("a v1 document editor", () => {
	it("writes an undeclared document from its template against a null base", async () => {
		stored[POLICY_PATH] = null;
		draw(<PolicyDocumentSection projectId="p1" canEdit />);
		expect(await screen.findByText("not declared")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.baseRevision).toBeNull();
		expect(sent[0]?.document.$schema).toBe("https://forge.sidcorp.co/schemas/policy-v1.json");
		expect(await screen.findByText("revision 1")).toBeInTheDocument();
	});

	it("sends the whole document against the revision it read", async () => {
		draw(<PolicyDocumentSection projectId="p1" canEdit />);
		const qa = await screen.findByLabelText("/qa");
		expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();
		fireEvent.change(qa, { target: { value: "independent" } });
		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({ path: POLICY_PATH, baseRevision: 1, document: { ...POLICY, qa: "independent" } });
		expect(await screen.findByText("revision 2")).toBeInTheDocument();
	});

	it("shows a refusal at the field its path names, and a missing key's at its parent", async () => {
		refuseWith = [
			{ code: "SCHEMA_VIOLATION", path: "/qa", detail: 'Invalid option: expected one of "self"|"independent"' },
			{ code: "SCHEMA_VIOLATION", path: "/intake/mode", detail: "Invalid input: expected string" },
		];
		draw(<PolicyDocumentSection projectId="p1" canEdit />);
		fireEvent.change(await screen.findByLabelText("/qa"), { target: { value: "nobody" } });
		fireEvent.click(screen.getByRole("button", { name: "Remove /intake/mode" }));
		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

		const qa = screen.getByLabelText("/qa");
		await waitFor(() => expect(qa).toHaveAttribute("aria-invalid", "true"));
		const said = document.getElementById(qa.getAttribute("aria-describedby") ?? "");
		expect(said).toHaveTextContent('SCHEMA_VIOLATION: Invalid option: expected one of "self"|"independent"');
		expect(screen.getByText("/intake/mode")).toBeInTheDocument();
		expect(screen.getByText("Each other refusal is shown at the field it names.")).toBeInTheDocument();
	});

	it("reads an unstored secret to a person, pointing at the Secrets form rather than at the API", async () => {
		refuseWith = [
			{
				code: "SECRET_NOT_FOUND",
				path: "/qa",
				detail: "secret://p1/ghost is not a secret of this project; PUT /api/projects/p1/secrets/<scope>/<name> first.",
			},
		];
		draw(<PolicyDocumentSection projectId="p1" canEdit />);
		fireEvent.change(await screen.findByLabelText("/qa"), { target: { value: "secret://p1/ghost" } });
		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

		const qa = screen.getByLabelText("/qa");
		await waitFor(() => expect(qa).toHaveAttribute("aria-invalid", "true"));
		const said = document.getElementById(qa.getAttribute("aria-describedby") ?? "");
		expect(said).toHaveTextContent("SECRET_NOT_FOUND: This secret is not stored in this project. Store it under Secrets on the Config tab, then save again.");
		expect(said).not.toHaveTextContent("PUT /api");
	});

	it("refuses a stale base, names what moved, and re-applies only when asked", async () => {
		draw(<PolicyDocumentSection projectId="p1" canEdit />);
		fireEvent.change(await screen.findByLabelText("/qa"), { target: { value: "independent" } });
		otherWriter((doc) => ({ ...doc, intake: { mode: "manual" } }));
		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

		const moved = await screen.findByRole("list", { name: "What moved" });
		expect(within(moved).getByText("intake.mode")).toBeInTheDocument();
		expect(moved).toHaveTextContent('you read "auto", it now holds "manual"');
		expect(screen.getByText("STALE_BASE")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();
		expect(stored[POLICY_PATH]?.document.qa).toBe("self");

		fireEvent.click(screen.getByRole("button", { name: "Re-apply my edits on revision 2" }));
		expect(screen.getByLabelText("/qa")).toHaveValue("independent");
		expect(screen.getByLabelText("/intake/mode")).toHaveValue("manual");
		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
		await waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]?.baseRevision).toBe(2);
		expect(sent[1]?.document).toMatchObject({ qa: "independent", intake: { mode: "manual" } });
	});

	it("marks a path both writers changed, and reload discards the person's edits", async () => {
		draw(<PolicyDocumentSection projectId="p1" canEdit />);
		fireEvent.change(await screen.findByLabelText("/qa"), { target: { value: "independent" } });
		otherWriter((doc) => ({ ...doc, qa: "self-checked" }));
		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

		const moved = await screen.findByRole("list", { name: "What moved" });
		expect(moved).toHaveTextContent("you edited this too; re-applying keeps your value");
		fireEvent.click(screen.getByRole("button", { name: "Reload, discarding my edits" }));
		expect(screen.getByLabelText("/qa")).toHaveValue("self-checked");
		expect(screen.queryByRole("list", { name: "What moved" })).not.toBeInTheDocument();
		expect(sent).toHaveLength(1);
	});

	it("refuses an edit that is not JSON in the JSON view and sends nothing", async () => {
		draw(<PolicyDocumentSection projectId="p1" canEdit />);
		await screen.findByLabelText("/qa");
		fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
		fireEvent.change(screen.getByLabelText("Policy (JSON)"), { target: { value: "{ not json" } });
		expect(screen.getByText(/^Not valid JSON/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();
		expect(sent).toHaveLength(0);
	});

	it("is read-only without edit rights", async () => {
		draw(<PolicyDocumentSection projectId="p1" canEdit={false} />);
		expect(await screen.findByLabelText("/qa")).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Save policy" })).not.toBeInTheDocument();
	});
});

describe("testing profiles", () => {
	it("writes a new profile at its own path and shows a refused delete by name", async () => {
		reads["/projects/p1/testing-profiles"] = () => ({ profiles: [], returned: 0 });
		draw(<TestingProfilesSection projectId="p1" canEdit />);
		const id = await screen.findByLabelText("New profile id");
		fireEvent.change(id, { target: { value: "Beta" } });
		expect(screen.getByText("A profile id matches ^[a-z][a-z0-9-]{0,62}$.")).toBeInTheDocument();
		fireEvent.change(id, { target: { value: "beta" } });
		fireEvent.click(screen.getByRole("button", { name: "Add a testing profile" }));
		fireEvent.click(await screen.findByRole("button", { name: "Save testing profile beta" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({ path: "/projects/p1/testing-profiles/beta", baseRevision: null, document: { id: "beta" } });
	});
});

describe("config explain", () => {
	it("names the layer and revision each effective value came from", async () => {
		reads["/projects/p1/config/effective"] = () => ({
			declared: true,
			revision: 4,
			device: null,
			undeclared: ["testing-profile", "device-binding"],
			values: {
				"/qa": { value: "self", from: "policy", revision: 7 },
				"/environments": { value: { live: { tier: "production" } }, from: "project", revision: 4 },
			},
		});
		draw(<EffectiveSection projectId="p1" />);
		const qa = (await screen.findByText("/qa")).closest("tr") as HTMLElement;
		expect(within(qa).getByText("policy")).toBeInTheDocument();
		expect(within(qa).getByText("7")).toBeInTheDocument();
		const env = screen.getByText("/environments").closest("tr") as HTMLElement;
		expect(within(env).getByText("project document")).toBeInTheDocument();
		expect(screen.getByText("Not declared: testing profile, device binding.")).toBeInTheDocument();
	});
});

describe("environment state", () => {
	it("shows each environment's deployed revision, evidence and probe status", async () => {
		reads["/projects/p1/environments/state"] = () => ({
			revision: 4,
			environments: [
				{
					environment: "live",
					state: "deployed",
					evidence: "runtime-mismatch",
					deployment: { id: "d1", provider: "coolify", status: "succeeded", at: "2026-10-01T00:00:00Z" },
					artifact: null,
					source: { kind: "revision", revision: "0123456789abcdef0123" },
					probes: [
						{ url: "https://x.example/version", identifies: "source", status: "mismatch", observed: "aaaaaaa", expected: "0123456" },
					],
				},
				{
					environment: "preview",
					state: "unknown",
					evidence: "none",
					reason: { cause: "external", message: "deployment mode is external" },
				},
			],
		});
		draw(<EnvironmentStateSection projectId="p1" />);
		const live = await screen.findByLabelText("Environment live");
		expect(within(live).getByText("Deployed")).toBeInTheDocument();
		expect(within(live).getByText("Evidence: Runtime mismatch")).toBeInTheDocument();
		expect(within(live).getByText("0123456789ab")).toBeInTheDocument();
		expect(within(live).getByText("Mismatch")).toBeInTheDocument();
		expect(live).toHaveTextContent("serves aaaaaaa, expected 0123456");
		const preview = screen.getByLabelText("Environment preview");
		expect(preview).toHaveTextContent("Deployed outside Forge: deployment mode is external");
	});

	it("says a project with no document names no environment", async () => {
		reads["/projects/p1/environments/state"] = () => {
			throw new ApiError(404, "no document", "PROJECT_DOCUMENT_NOT_FOUND");
		};
		draw(<EnvironmentStateSection projectId="p1" />);
		expect(await screen.findByText("No project document is declared, so it names no environment.")).toBeInTheDocument();
	});
});

describe("secrets", () => {
	const profile = {
		profileId: "beta",
		declared: true,
		revision: 1,
		document: {
			id: "beta",
			actors: { admin: { role: "org-admin", credential: "secret://beta/admin" } },
			services: { api: { access: "readonly", credential: "secret://beta/api-key" } },
			limits: [],
		},
	};

	beforeEach(() => {
		reads["/projects/p1/testing-profiles"] = () => ({ profiles: [profile], returned: 1 });
	});

	it("marks each referenced secret stored or missing, and writes a value it never shows", async () => {
		reads["/projects/p1/secrets"] = () => ({
			secrets: [{ ref: "secret://beta/admin", scope: "beta", name: "admin", updatedAt: "2026-10-01T00:00:00.000Z" }],
			returned: 1,
		});
		draw(<SecretsSection projectId="p1" canEdit />);
		const admin = (await screen.findByText("secret://beta/admin", { selector: "code" })).closest("tr") as HTMLElement;
		expect(within(admin).getByText("value stored")).toBeInTheDocument();
		const api = screen.getByText("secret://beta/api-key", { selector: "code" }).closest("tr") as HTMLElement;
		expect(within(api).getByText("missing — no value stored")).toBeInTheDocument();

		fireEvent.click(within(api).getByRole("button", { name: "Set value" }));
		expect(screen.getByLabelText("Scope")).toHaveValue("beta");
		expect(screen.getByLabelText("Name")).toHaveValue("api-key");
		const value = screen.getByLabelText("Value");
		expect(value).toHaveAttribute("type", "password");
		fireEvent.change(value, { target: { value: "s3cret-value" } });
		fireEvent.click(screen.getByRole("button", { name: "Store value for secret://beta/api-key" }));
		await waitFor(() => expect(secretWrites).toHaveLength(1));
		expect(secretWrites[0]).toEqual({ path: "/projects/p1/secrets/beta/api-key", body: { value: "s3cret-value" } });
		await waitFor(() => expect(screen.getByLabelText("Value")).toHaveValue(""));
		expect(screen.queryByText(/s3cret-value/)).not.toBeInTheDocument();
	});

	it("never reads a reference as stored when the names could not be read", async () => {
		reads["/projects/p1/secrets"] = () => {
			throw new ApiError(500, "boom", "INTERNAL_ERROR");
		};
		draw(<SecretsSection projectId="p1" canEdit />);
		expect(await screen.findByText(/The stored secret names could not be read/)).toBeInTheDocument();
		expect(screen.getAllByText("could not be read")).toHaveLength(2);
		expect(screen.queryByText("value stored")).not.toBeInTheDocument();
	});
});
