import { describe, expect, it } from "vitest";
import {
	storefrontArtifactOf,
	storefrontLandingClauses,
} from "./landing-artifacts.js";

// Refs as HOP's marks wrote them for release 0.3.0: what each names first decides its kind.
describe("storefrontArtifactOf", () => {
	it("reads a workflow and the graph it landed at, from either way a mark wrote it", () => {
		expect(
			storefrontArtifactOf(
				"workflow 187 hop_patient_360 @ draft af5e754739b3fb7d7408adc01fc3dcb20f6cb6a7a8ac266f4b2e68e9ec475b4d",
			),
		).toEqual({
			kind: "workflow",
			id: "187",
			graph: "af5e754739b3fb7d7408adc01fc3dcb20f6cb6a7a8ac266f4b2e68e9ec475b4d",
		});
		expect(
			storefrontArtifactOf(
				"autoflow hop draft workflow 96 @d00d9028: stamp block",
			),
		).toEqual({ kind: "workflow", id: "96", graph: "d00d9028" });
		expect(storefrontArtifactOf("workflow 166 hop_staff@9b34a8f4")).toEqual({
			kind: "workflow",
			id: "166",
			graph: "9b34a8f4",
		});
		expect(
			storefrontArtifactOf("workflow 178 hop_report (published version 1)"),
		).toEqual({ kind: "workflow", id: "178", graph: null });
	});

	it("reads routes, pages and a theme with its files and sha-256", () => {
		expect(
			storefrontArtifactOf(
				"route 338 GET /hop/rules/dry-run (end_user, unpublished)",
			),
		).toEqual({ kind: "route", id: "338" });
		expect(
			storefrontArtifactOf(
				"draft page 20 /pages/patients (section hop-patient-360, draft theme 568)",
			),
		).toEqual({ kind: "page", id: "20" });
		expect(
			storefrontArtifactOf(
				"theme 796 assets/hop-staff-shell.js 336f999b, assets/hop-staff-shell.css b5750549 (published)",
			),
		).toEqual({
			kind: "theme",
			id: "796",
			files: [
				{ path: "assets/hop-staff-shell.js", checksum: "336f999b" },
				{ path: "assets/hop-staff-shell.css", checksum: "b5750549" },
			],
		});
		expect(
			storefrontArtifactOf(
				"draft theme 568 sections/hop-patient-360.liquid (sha256 b9bec199)",
			),
		).toEqual({
			kind: "theme",
			id: "568",
			files: [
				{ path: "sections/hop-patient-360.liquid", checksum: "b9bec199" },
			],
		});
		expect(
			storefrontArtifactOf(
				"theme 520 published as main (adds sections/hop-reports.liquid, assets/hop-reports.js; replaces 496)",
			),
		).toEqual({
			kind: "theme",
			id: "520",
			files: [
				{ path: "sections/hop-reports.liquid", checksum: null },
				{ path: "assets/hop-reports.js", checksum: null },
			],
		});
	});

	it("names nothing for what the provider keeps no state of, or a file on no theme", () => {
		expect(storefrontArtifactOf("table 150 hop_report_definitions")).toBeNull();
		expect(
			storefrontArtifactOf("api-hop.auto.sidcorp.co (backend domain 244)"),
		).toBeNull();
		expect(
			storefrontArtifactOf(
				"assets/hop-patient-360.js sha256 8bca1d54, repo main 9d6d6ce: REPO ONLY, on no theme and NOT PUBLISHED (served theme 812 has a3648281)",
			),
		).toBeNull();
		expect(storefrontArtifactOf("hop-staff-shell-ux@rev3")).toBeNull();
	});
});

describe("storefrontLandingClauses", () => {
	it("reads a landing written before artifacts existed, clause by clause", () => {
		expect(
			storefrontLandingClauses(
				"ui: https://hop.auto.sidcorp.co/ served by theme 800 (templates/index.json, the hop-staff-shell section); setting: store 11 commerce_enabled false",
			).map((c) => c.artifact),
		).toEqual([
			{
				kind: "theme",
				id: "800",
				files: [{ path: "templates/index.json", checksum: null }],
			},
			{ kind: "setting", key: "commerce_enabled", value: "false" },
		]);
		expect(
			storefrontLandingClauses("https://hop.auto.sidcorp.co/pages/staff"),
		).toEqual([
			{ ref: "https://hop.auto.sidcorp.co/pages/staff", artifact: null },
		]);
	});
});
