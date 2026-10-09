import { describe, expect, it } from "vitest";
import { customerNotes, notesCallingItDemo } from "./customer-notes.js";
import type { ReleaseNoteSection } from "./releases.js";

// The HOP journey walk (2026-10-08): the 0.5.0 notes could not be handed to a customer. Each line
// carried its issue key and internal title, notes named internal paths, ISS-102 and the issue that
// published it (ISS-122) both described the CRM report screen, and nothing copied or exported them.

const entry = (key: string, title: string, userFacing: string) => ({
	key,
	title,
	userFacing,
	technical: null,
});

const SECTIONS: ReleaseNoteSection[] = [
	{
		section: "Added",
		entries: [
			entry(
				"ISS-102",
				"Demo CRM report screen: catalogue, campaign ROI",
				"CRM reports and campaign ROI: each report names its definition and refresh time.",
			),
			entry(
				"ISS-122",
				"Publish the ROI slice and reports (ISS-102) to the dev site: workflow 178, routes 221/222",
				"The demo site now has the CRM report screen at /pages/reports.",
			),
			entry(
				"ISS-83",
				"Patient 360 screen for staff",
				"Staff open a patient's 360 record (/pages/patients?key=<HOP key>, ISS-78) from the staff menu.",
			),
			entry(
				"ISS-90",
				"Campaign approval guard",
				"A campaign is sent for approval only when every item is filled.",
			),
			entry(
				"ISS-91",
				"Campaign approval guard, second slice",
				"A campaign is sent for approval only when every item is filled. ",
			),
			entry(
				"ISS-95",
				"Maker-checker on campaigns",
				"Approval follows SOD-RULE-MAKER-CHECKER at /hop/campaigns/sign.",
			),
		],
	},
	{
		section: "Fixed",
		entries: [
			entry(
				"ISS-125",
				"Home page showed the store theme sample",
				"The home page opens the staff overview instead of a shop sample.",
			),
		],
	},
];

describe("release notes a customer can be handed", () => {
	const view = customerNotes(SECTIONS);
	const lines = view.sections.flatMap((s) => s.lines);
	const all = () => lines.join("\n");

	it("names no issue key, internal title or internal path, taking out the brackets that held them", () => {
		const all = lines.join("\n");
		expect(all).not.toMatch(/\b(?:ISS|REQ|FB)-\d+/);
		expect(all).not.toMatch(/\/pages\//);
		expect(all).not.toContain("Publish the ROI slice");
		expect(lines).toContain(
			"Staff open a patient's 360 record from the staff menu.",
		);
	});

	it("holds back a note whose engineering detail sits in its sentence, naming what it carries", () => {
		expect(all()).not.toContain("SOD-RULE-MAKER-CHECKER");
		expect(view.held).toEqual([
			{
				key: "ISS-95",
				references: ["code SOD-RULE-MAKER-CHECKER", "path /hop/campaigns/sign"],
			},
		]);
	});

	it("folds an issue that ships another issue's change in this release into that change", () => {
		expect(view.sections[0]?.lines).not.toContain(
			"The demo site now has the CRM report screen.",
		);
		expect(view.folded).toContainEqual({
			key: "ISS-122",
			why: "carries",
			into: ["ISS-102"],
		});
	});

	it("keeps one line where two notes say the same", () => {
		expect(
			lines.filter((l) => l.startsWith("A campaign is sent for approval")),
		).toHaveLength(1);
		expect(view.folded).toContainEqual({
			key: "ISS-91",
			why: "duplicate",
			into: ["ISS-90"],
		});
	});

	it("keeps each section's order and drops an empty one", () => {
		expect(view.sections.map((s) => s.section)).toEqual(["Added", "Fixed"]);
		expect(
			customerNotes([{ section: "Changed", entries: [] }]).sections,
		).toEqual([]);
	});
});

describe("notes that call the build a demo", () => {
	it("names each note whose user line says demo, dev or test data, and no other", () => {
		const sections: ReleaseNoteSection[] = [
			{
				section: "Added",
				entries: [
					entry("ISS-122", "t", "The demo site now has the CRM report screen."),
					entry("ISS-123", "t", "Site demo HOP (bản dev) có thêm Patient 360."), // i18n-allow: a HOP note as written
					entry("ISS-124", "t", "Hồ sơ dùng dữ liệu TEST."), // i18n-allow: a HOP note as written
					entry(
						"ISS-125",
						"t",
						"Staff developed a habit of opening the overview first.",
					),
				],
			},
		];
		expect(notesCallingItDemo(sections)).toEqual([
			"ISS-122",
			"ISS-123",
			"ISS-124",
		]);
	});
});
