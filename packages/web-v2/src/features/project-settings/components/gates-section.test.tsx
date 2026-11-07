// REQ-76 BC-12: a project's gates are set in settings by one choice, its profile. Routine approval is a
// defect (owner, 2026-11-06), so no gate has a switch of its own here (ISS-1071): every policy gate is
// listed by its name with the mode it takes here as a badge, never a config key, and a save writes the
// profile with the overrides the project already holds, unchanged, at the revision read and with a
// reason. What core refuses is shown as it wrote it.
// BC-13: a project Forge raised after an incident says so, and that only a person lowers it.
// @direct-test-of packages/web-v2/src/lib/i18n/copy/project-settings.json

import { GATE_CATALOG, KERNEL_RULES } from "@forge/contracts/gate-profiles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore } from "@/test/render";
import type { ProjectGates } from "../types";
import { GatesSettings } from "./gates-section";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const P = "11111111-1111-4111-8111-111111111111";
const CATALOG = { profiles: ["strict", "standard", "yolo"], modes: ["enforce", "advise", "off"], gates: GATE_CATALOG, kernel: KERNEL_RULES };

const resolved = (overrides: Record<string, string> = {}): ProjectGates["gates"] =>
	GATE_CATALOG.map((g) =>
		overrides[g.id]
			? { id: g.id, mode: overrides[g.id] as "off", profile: "standard", from: "override", key: `gates.overrides.${g.id}` }
			: typeof g.defaults.standard === "string"
				? { id: g.id, mode: g.defaults.standard, profile: "standard", from: "profile", key: "gates.profile" }
				: { id: g.id, mode: "enforce", profile: "standard", from: "key", key: g.defaults.standard.key },
	);

const view = (extra: Partial<ProjectGates> = {}): ProjectGates => ({
	declared: true,
	revision: 4,
	profile: "standard",
	raised: null,
	overrides: { merge_check: "off" },
	gates: resolved({ merge_check: "off" }),
	changes: [
		{
			at: "2026-10-20T08:00:00.000Z",
			configRevision: 4,
			profileFrom: "strict",
			profileTo: "standard",
			overridesFrom: {},
			overridesTo: { merge_check: "off" },
			actorKind: "person",
			actorUserId: "u1",
			actorName: "Chuong",
			cause: "set",
			reason: "merge checks run in CI",
			ref: null,
		},
	],
	...extra,
});

function core(read: ProjectGates, put?: (c: Call) => { status?: number; body: unknown }): Call[] {
	return fakeCore((c) => {
		if (c.method === "GET" && c.path === "/gates") return { body: CATALOG };
		if (c.method === "GET" && c.path === `/projects/${P}/gates`) return { body: read };
		if (c.method === "PUT" && c.path === `/projects/${P}/gates`) return put ? put(c) : { body: { ...read, revision: 5 } };
		return undefined;
	});
}

type Access = Parameters<typeof GatesSettings>[0]["access"];
const ORG_OWNER: Access = { orgRole: "owner", role: null };

function mount(access: Access = ORG_OWNER) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<GatesSettings projectId={P} slug="hop" access={access} />
		</QueryClientProvider>,
	);
}

const row = (id: string) => screen.findByTestId(`gate-${id}`);
const save = () => screen.getByRole("button", { name: "Save changes" });
const putOf = (calls: Call[]) => calls.find((c) => c.method === "PUT")?.body;

afterEach(() => vi.unstubAllGlobals());

describe("the gates section", () => {
	it("lists every gate by name with the mode it takes here as a badge, and no switch or config key", async () => {
		core(view());
		mount();
		const admit = await row("approval_admit");
		expect(admit).toHaveTextContent(/^A person admits issues/);
		expect(within(admit).getByTestId("enum-badge")).toHaveTextContent("Enforce");
		expect(within(await row("merge_check")).getByTestId("enum-badge")).toHaveTextContent("Off");
		expect(screen.getAllByTestId(/^gate-[a-z_]+$/)).toHaveLength(GATE_CATALOG.length);
		const page = document.body.textContent ?? "";
		expect(page).not.toMatch(/approvals\.|plan\.approval|validation\.|policy\.|its own switch|Config key|switches/);
		expect(screen.queryAllByRole("combobox")).toEqual([]);
		expect(screen.queryAllByRole("switch")).toEqual([]);
		const kernel = within(screen.getByTestId("gates-kernel")).getAllByRole("listitem");
		expect(kernel).toHaveLength(KERNEL_RULES.length);
		for (const k of KERNEL_RULES) expect(page).not.toContain(k.id);
		expect(screen.getByText("Always enforced")).toBeInTheDocument();
		const change = within(screen.getByTestId("gates-changes")).getAllByRole("listitem")[0];
		if (!change) throw new Error("the change made at revision 4 is not listed");
		expect(change).toHaveTextContent("Strict → Standard");
		expect(change).toHaveTextContent("Chuong");
		expect(change).toHaveTextContent("Merge check recorded");
		expect(change).not.toHaveTextContent("merge_check");
	});

	it("sends the profile chosen with the overrides held unchanged, the revision read and the reason", async () => {
		const calls = core(view());
		mount();
		await row("issue_ready");
		fireEvent.click(screen.getByRole("radio", { name: /^Yolo/ }));
		fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "  trial week  " } });
		fireEvent.click(save());
		await waitFor(() => expect(putOf(calls)).toBeDefined());
		expect(putOf(calls)).toEqual({ baseRevision: 4, profile: "yolo", overrides: { merge_check: "off" }, reason: "trial week" });
	});

	it("holds save while no reason is given, and shows core's refusal as core wrote it", async () => {
		const detail = "Forge raised this project from `yolo` to `standard` after a failed deploy (d-1) on 2026-10-27, and only a person lowers it again (REQ-76 BC-13)";
		const calls = core(view(), () => ({ status: 409, body: { error: { code: "GATES_REFUSED", message: "refused", refusals: [{ code: "GATE_PROFILE_RAISED", path: "/profile", detail }] } } }));
		mount();
		await row("issue_ready");
		fireEvent.click(screen.getByRole("radio", { name: /^Yolo/ }));
		expect(save()).toBeDisabled();
		fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "   " } });
		expect(save()).toBeDisabled();
		expect(putOf(calls)).toBeUndefined();
		fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "loosen it" } });
		fireEvent.click(save());
		const refused = await screen.findByTestId("gates-refused");
		expect(refused).toHaveTextContent(`GATE_PROFILE_RAISED /profile: ${detail}`);
		expect(screen.getByRole("radio", { name: /^Yolo/ })).toBeChecked();
	});

	it("says Forge raised the project after an incident, and that only a person lowers it", async () => {
		core(view({ raised: { from: "yolo", cause: "deploy_failed", ref: "deploy d-1", at: "2026-10-27T09:30:00.000Z" } }));
		mount();
		const banner = await screen.findByTestId("gates-raised");
		expect(banner).toHaveTextContent(/^Forge raised this project from Yolo to Standard after a failed deploy \(deploy d-1, .+\)\. Only a person lowers it again\.$/);
	});

	it("is editable by a project admin who is not an org admin, since PUT /gates asks project.admin", async () => {
		const calls = core(view());
		mount({ orgRole: "member", role: "admin" });
		await row("issue_ready");
		fireEvent.click(screen.getByRole("radio", { name: /^Strict/ }));
		fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "project admin" } });
		fireEvent.click(save());
		await waitFor(() => expect(putOf(calls)).toMatchObject({ profile: "strict", overrides: { merge_check: "off" } }));
	});

	it("is read-only for a plain member: no reason, no save, the profile held", async () => {
		core(view());
		mount({ orgRole: "member", role: "member" });
		await row("issue_ready");
		expect(screen.getByRole("radio", { name: /^Yolo/ })).toHaveAttribute("aria-disabled", "true");
		expect(screen.queryByRole("textbox", { name: "Reason" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
	});
});
