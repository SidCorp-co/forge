// A project's Gates settings (REQ-76 BC-12, BC-13) witnessed at phone and desktop width, light and
// dark: every gate of the catalog is drawn as a row of one flush table, a project Forge raised says
// so above it, the kernel and the changes are listed, and nothing scrolls the page sideways (the
// table scrolls inside its own region).
//
//   pnpm --filter web-v2 witness witness/gate-profiles.witness.tsx --out <dir>

import { GATE_CATALOG, KERNEL_RULES } from "@forge/contracts/gate-profiles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { GatesSettings } from "@/features/project-settings/components/gates-section";
import type { ProjectGates } from "@/features/project-settings/types";
import "./entry";
import { InRouter } from "./router";

const P = "11111111-1111-4111-8111-111111111111";
const OVERRIDES = { issue_ready: "advise", merge_check: "off" } as const;

const gates: ProjectGates["gates"] = GATE_CATALOG.map((g) => {
	const held = (OVERRIDES as Record<string, "advise" | "off">)[g.id];
	if (held) return { id: g.id, mode: held, profile: "standard", from: "override", key: `gates.overrides.${g.id}` };
	const d = g.defaults.standard;
	return typeof d === "string"
		? { id: g.id, mode: d, profile: "standard", from: "profile", key: "gates.profile" }
		: { id: g.id, mode: "off", profile: "standard", from: "key", key: d.key };
});

const VIEW: ProjectGates = {
	declared: true,
	revision: 9,
	profile: "standard",
	raised: { from: "yolo", cause: "deploy_failed", ref: "deploy 0.4.0-dev.348", at: "2026-10-27T09:30:00.000Z" },
	overrides: OVERRIDES,
	gates,
	changes: [
		{
			at: "2026-10-27T09:30:00.000Z",
			configRevision: 9,
			profileFrom: "yolo",
			profileTo: "standard",
			overridesFrom: { scope_hold: "off" },
			overridesTo: {},
			actorKind: "forge",
			actorUserId: null,
			actorName: null,
			cause: "deploy_failed",
			reason: "the deploy of 0.4.0-dev.348 failed its health check",
			ref: "deploy 0.4.0-dev.348",
		},
		{
			at: "2026-10-20T08:00:00.000Z",
			configRevision: 8,
			profileFrom: "standard",
			profileTo: "yolo",
			overridesFrom: {},
			overridesTo: { scope_hold: "off" },
			actorKind: "person",
			actorUserId: "u1",
			actorName: "Chuong",
			cause: "set",
			reason: "demo week: agents act first",
			ref: null,
		},
	],
};

window.fetch = async () => new Promise<Response>(() => {});
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["gates", "catalog"], { profiles: ["strict", "standard", "yolo"], modes: ["enforce", "advise", "off"], gates: GATE_CATALOG, kernel: KERNEL_RULES });
client.setQueryData(["project", P, "gates"], VIEW);

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
	<InRouter at="/projects/hop/settings" pattern="/projects/$slug/settings">
		<QueryClientProvider client={client}>
			<div className="min-h-dvh bg-app p-4 sm:p-8" data-witness="page">
				<GatesSettings projectId={P} slug="hop" access={{ orgRole: "member", role: "admin" }} />
			</div>
		</QueryClientProvider>
	</InRouter>,
);

const text = () => document.querySelector<HTMLElement>("[data-witness=page]")?.innerText ?? "";
const has = (needle: string) => (text().includes(needle) ? [] : [`"${needle}" is not drawn`]);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
	document.documentElement.dataset.theme = t;
	document.documentElement.classList.toggle("dark", t === "dark");
};

function reads(): string[] {
	const rows = document.querySelectorAll("[data-testid^=gate-]").length;
	return [
		...has("Forge raised this project from Yolo to Standard after a failed deploy"),
		...has("Only a person lowers it again."),
		...has("its own switch: approvals.admit"),
		...has("Always enforced"),
		...has("Raised after a failed deploy"),
		...(rows === GATE_CATALOG.length ? [] : [`${rows} gate rows drawn of ${GATE_CATALOG.length}`]),
		...(document.documentElement.scrollWidth > window.innerWidth
			? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in a ${window.innerWidth} px window`]
			: []),
	];
}

window.__witness = {
	cases: [
		{ name: "desktop", width: 1440 },
		{ name: "phone", width: 390 },
	],
	ready: () => Boolean(document.querySelector("[data-testid=gates-section]")),
	stages: (["light", "dark"] as const).map((t) => ({
		name: t,
		run: async () => {
			theme(t);
			await pause(300);
			return reads();
		},
	})),
};
