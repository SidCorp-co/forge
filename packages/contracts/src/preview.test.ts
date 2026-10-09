import { describe, expect, it } from "vitest";
import {
	detectPreviewSettings,
	PREVIEW_MACHINE,
	PREVIEW_REFUSAL_CODES,
	previewLabelOf,
	previewRecordSchema,
	previewReportSchema,
	previewSettingsSchema,
	type RepositoryFacts,
} from "./preview.js";
import { refusalStatusOf } from "./refusal-statuses.js";
import { exitsOf } from "./state-machine.js";

const issuesOf = (
	schema: {
		safeParse: (v: unknown) => {
			success: boolean;
			error?: { issues: { path: PropertyKey[]; message: string }[] };
		};
	},
	value: unknown,
) => {
	const parsed = schema.safeParse(value);
	return parsed.success
		? []
		: (parsed.error?.issues ?? []).map(
				(i) => `${i.path.join("/")}: ${i.message}`,
			);
};

describe("the preview machine (REQ-39 BC-9)", () => {
	it("holds the six states, written out here rather than read from the list under test", () => {
		expect([...PREVIEW_MACHINE.states]).toEqual([
			"starting",
			"live",
			"idle_closed",
			"approved",
			"abandoned",
			"failed",
		]);
		expect([...PREVIEW_MACHINE.terminal]).toEqual([
			"approved",
			"abandoned",
			"failed",
		]);
	});

	it("closes on approval, abandonment or idleness, and only idleness can be reopened", () => {
		expect(exitsOf(PREVIEW_MACHINE, "starting")).toEqual([
			"live",
			"failed",
			"abandoned",
		]);
		expect(exitsOf(PREVIEW_MACHINE, "live")).toEqual([
			"failed",
			"idle_closed",
			"approved",
			"abandoned",
		]);
		expect(exitsOf(PREVIEW_MACHINE, "idle_closed")).toEqual([
			"starting",
			"approved",
			"abandoned",
		]);
		for (const closed of ["approved", "abandoned", "failed"] as const) {
			expect(exitsOf(PREVIEW_MACHINE, closed)).toEqual([]);
		}
	});

	it("lets only the kernel say a dev server is up, down or idle, and a person approve or abandon", () => {
		const permissionOf = (act: string) => [
			...new Set(
				PREVIEW_MACHINE.edges
					.filter((e) => e.act === act)
					.map((e) => e.permission),
			),
		];
		expect(permissionOf("preview.live")).toEqual([null]);
		expect(permissionOf("preview.failed")).toEqual([null]);
		expect(permissionOf("preview.idleClosed")).toEqual([null]);
		expect(permissionOf("preview.approved")).toEqual(["previews.approve"]);
		expect(permissionOf("preview.abandoned")).toEqual(["project.write"]);
	});

	it("asks a reason of every failure and abandonment", () => {
		expect([...PREVIEW_MACHINE.reasonRequired]).toEqual([
			"abandoned",
			"failed",
		]);
	});
});

describe("the preview setting (BC-11)", () => {
	it("takes a command holding {port}, or a fixed port, and refuses both or neither by name", () => {
		expect(
			issuesOf(previewSettingsSchema, {
				command: "pnpm run dev --port {port}",
			}),
		).toEqual([]);
		expect(
			issuesOf(previewSettingsSchema, { command: "pnpm run dev", port: 3000 }),
		).toEqual([]);
		expect(
			issuesOf(previewSettingsSchema, {
				command: "pnpm run dev --port {port}",
				port: 3000,
			}),
		).toEqual([
			"port: preview.port is set and the command holds {port}: name one port, either a fixed one or the placeholder the runner fills",
		]);
		expect(
			issuesOf(previewSettingsSchema, { command: "pnpm run dev" }),
		).toEqual([
			"port: preview.port is required when the command does not hold {port}: the preview has to know where the dev server listens",
		]);
	});

	it("keeps the port off the privileged range and the idle timeout between 5 and 240 minutes", () => {
		expect(
			issuesOf(previewSettingsSchema, { command: "x", port: 1023 }),
		).toHaveLength(1);
		expect(
			issuesOf(previewSettingsSchema, { command: "x", port: 1024 }),
		).toEqual([]);
		expect(
			issuesOf(previewSettingsSchema, { command: "x", port: 65_536 }),
		).toHaveLength(1);
		expect(
			issuesOf(previewSettingsSchema, { command: "x {port}", idleMinutes: 4 }),
		).toHaveLength(1);
		expect(
			issuesOf(previewSettingsSchema, { command: "x {port}", idleMinutes: 5 }),
		).toEqual([]);
		expect(
			issuesOf(previewSettingsSchema, {
				command: "x {port}",
				idleMinutes: 240,
			}),
		).toEqual([]);
		expect(
			issuesOf(previewSettingsSchema, {
				command: "x {port}",
				idleMinutes: 241,
			}),
		).toHaveLength(1);
	});

	it("runs only inside the repository", () => {
		expect(
			issuesOf(previewSettingsSchema, {
				command: "x {port}",
				cwd: "packages/web-v2",
			}),
		).toEqual([]);
		for (const cwd of ["/etc", "../other", "packages/../../x"]) {
			expect(
				issuesOf(previewSettingsSchema, { command: "x {port}", cwd }),
			).toEqual([
				"cwd: preview.cwd is a directory inside the repository: relative, with no `..`",
			]);
		}
	});

	it("refuses a key it does not hold", () => {
		expect(
			issuesOf(previewSettingsSchema, { command: "x {port}", host: "0.0.0.0" }),
		).toHaveLength(1);
	});
});

const facts = (
	pkg: unknown,
	lockfiles: string[] = [],
	cwd = "",
): RepositoryFacts => ({
	cwd,
	packageJson:
		pkg === null ? null : typeof pkg === "string" ? pkg : JSON.stringify(pkg),
	lockfiles,
});

describe("reading the setting from the repository (BC-11, BC-12)", () => {
	it("starts a Next app with pnpm on a port the runner picks", () => {
		const found = detectPreviewSettings(
			facts(
				{
					scripts: { dev: "next dev --turbopack" },
					dependencies: { next: "15.5.0" },
				},
				["pnpm-lock.yaml"],
				"packages/web-v2",
			),
		);
		expect(found).toEqual({
			ok: true,
			settings: {
				command: "pnpm run dev --port {port}",
				cwd: "packages/web-v2",
			},
			framework: "next",
			packageManager: "pnpm",
		});
	});

	it("passes npm's argument separator for a Vite app, which is not Forge's own stack", () => {
		const found = detectPreviewSettings(
			facts({ scripts: { dev: "vite" }, devDependencies: { vite: "^7.0.0" } }, [
				"package-lock.json",
			]),
		);
		expect(found).toEqual({
			ok: true,
			settings: { command: "npm run dev -- --port {port}" },
			framework: "vite",
			packageManager: "npm",
		});
		expect(found.ok && issuesOf(previewSettingsSchema, found.settings)).toEqual(
			[],
		);
	});

	it("trusts the packageManager field over a stray lockfile", () => {
		const found = detectPreviewSettings(
			facts(
				{
					packageManager: "yarn@4.5.0",
					scripts: { dev: "astro dev" },
					dependencies: { astro: "5" },
				},
				["package-lock.json"],
			),
		);
		expect(found.ok && found.settings.command).toBe(
			"yarn run dev --port {port}",
		);
	});

	it("keeps the port a script fixes for itself", () => {
		const found = detectPreviewSettings(
			facts({
				scripts: { dev: "next dev -p 4100" },
				dependencies: { next: "15" },
			}),
		);
		expect(found.ok && found.settings).toEqual({
			command: "npm run dev",
			port: 4100,
		});
	});

	it("names the missing start command rather than guessing one", () => {
		expect(detectPreviewSettings(facts(null))).toEqual({
			ok: false,
			reason: "NO_START_COMMAND",
			detail: "package.json does not exist; set preview.command",
		});
		expect(
			detectPreviewSettings(
				facts({ scripts: { start: "next start" } }, [], "web"),
			),
		).toEqual({
			ok: false,
			reason: "NO_START_COMMAND",
			detail: 'web/package.json has no "dev" script; set preview.command',
		});
		expect(detectPreviewSettings(facts("{not json"))).toMatchObject({
			ok: false,
			reason: "NO_START_COMMAND",
		});
		expect(detectPreviewSettings(facts("[]"))).toMatchObject({
			ok: false,
			reason: "NO_START_COMMAND",
		});
	});

	it("names a dev server whose port it cannot tell", () => {
		expect(
			detectPreviewSettings(facts({ scripts: { dev: "node server.js" } })),
		).toEqual({
			ok: false,
			reason: "PORT_UNDECLARED",
			detail:
				'package.json "dev" runs "node server.js", whose port Forge cannot tell; set preview.port or a command holding {port}',
		});
	});
});

describe("the preview host (BC-4)", () => {
	const domain = "preview.example.dev";
	it("is one label under the preview domain, whatever the case or port", () => {
		expect(
			previewLabelOf("p-abcdefghijkmnop2.preview.example.dev", domain),
		).toBe("p-abcdefghijkmnop2");
		expect(
			previewLabelOf("P-ABCDEFGHIJKMNOP2.Preview.Example.Dev:443", domain),
		).toBe("p-abcdefghijkmnop2");
	});

	it("names no preview for Forge's own hosts, a nested label or another domain", () => {
		expect(previewLabelOf("forge-dev-api.sidcorp.co", domain)).toBeNull();
		expect(
			previewLabelOf("p-abcdefghijk2345678.preview.example.dev", domain),
		).toBeNull();
		expect(
			previewLabelOf("x.p-abcdefghijkmnop2.preview.example.dev", domain),
		).toBeNull();
		expect(
			previewLabelOf("p-abcdefghijkmnop2.preview.example.dev.evil.co", domain),
		).toBeNull();
		expect(previewLabelOf("preview.example.dev", domain)).toBeNull();
	});
});

describe("the preview refusals", () => {
	it("answer the status their meaning picks", () => {
		const statuses = Object.fromEntries(
			PREVIEW_REFUSAL_CODES.map((c) => [c, refusalStatusOf(c)]),
		);
		expect(statuses).toEqual({
			PREVIEW_NOT_FOUND: 404,
			PREVIEW_FORBIDDEN: 403,
			PREVIEW_TICKET_INVALID: 403,
			PREVIEW_CLOSED: 409,
			PREVIEW_NOT_LIVE: 409,
			PREVIEW_ALREADY_OPEN: 409,
			PREVIEW_NO_RUN: 422,
			PREVIEW_SETTINGS_INVALID: 400,
			PREVIEW_PRODUCTION_ENVIRONMENT: 422,
			PREVIEW_RUNNER_UNSUPPORTED: 422,
			PREVIEW_SNAPSHOT_UNAVAILABLE: 503,
			PREVIEW_DOMAIN_UNCONFIGURED: 503,
			PREVIEW_TUNNEL_DOWN: 503,
		});
	});
});

describe("what the runner reports", () => {
	it("takes a failure only with a named reason", () => {
		expect(
			issuesOf(previewReportSchema, {
				kind: "failed",
				reason: "PORT_IN_USE",
				detail: "3000 held by pid 9",
			}),
		).toEqual([]);
		expect(
			issuesOf(previewReportSchema, {
				kind: "failed",
				reason: "BROKEN",
				detail: "",
			}),
		).toHaveLength(1);
	});

	it("takes a snapshot only with a whole base sha and patch id", () => {
		const snapshot = {
			kind: "snapshot",
			base: "a".repeat(40),
			patchId: "b".repeat(40),
			files: ["a.tsx"],
		};
		expect(issuesOf(previewReportSchema, snapshot)).toEqual([]);
		expect(
			issuesOf(previewReportSchema, { ...snapshot, base: "abc1234" }),
		).toEqual(["base: base is a whole git sha: 40 hex characters"]);
	});

	it("refuses a kind it does not hold", () => {
		expect(issuesOf(previewReportSchema, { kind: "traffic" })).toHaveLength(1);
	});
});

describe("the preview record", () => {
	it("is what REST answers, and nothing more", () => {
		const record = {
			id: "6f1d3c1e-8a0b-4c55-9d43-2f3a1b0c9e11",
			projectId: "d1bb4907-74d9-4228-85ff-76121523af7d",
			issueId: "6f1d3c1e-8a0b-4c55-9d43-2f3a1b0c9e15",
			sessionId: "6f1d3c1e-8a0b-4c55-9d43-2f3a1b0c9e12",
			deviceId: "6f1d3c1e-8a0b-4c55-9d43-2f3a1b0c9e13",
			url: "https://p-abcdefghijkmnop2.preview.example.dev/",
			state: "failed",
			reason: "DEV_SERVER_EXITED",
			detail: "exit 1: Error: Cannot find module 'next'",
			command: "pnpm run dev --port {port}",
			port: null,
			idleMinutes: 30,
			approvedPatchId: null,
			approvedBy: null,
			createdBy: "6f1d3c1e-8a0b-4c55-9d43-2f3a1b0c9e14",
			createdAt: "2026-10-09T10:00:00.000Z",
			liveAt: null,
			lastViewedAt: null,
			closedAt: "2026-10-09T10:01:00.000Z",
		};
		expect(issuesOf(previewRecordSchema, record)).toEqual([]);
		expect(
			issuesOf(previewRecordSchema, { ...record, state: "closed" }),
		).toHaveLength(1);
		expect(
			issuesOf(previewRecordSchema, { ...record, worktreePath: "/home/x" }),
		).toHaveLength(1);
	});
});
