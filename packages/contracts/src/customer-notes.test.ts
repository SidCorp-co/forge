import { describe, expect, it } from "vitest";
import { customerNotes, notesCallingItDemo } from "./customer-notes.js";
import type { ReleaseNoteSection } from "./releases.js";

// The HOP journey walk (2026-10-08): the 0.5.0 notes could not be handed to a customer. Each line
// carried its issue key and internal title, notes named internal paths, ISS-102 and the issue that
// published it (ISS-122) both described the CRM report screen, and nothing copied or exported them.

const entry = (
	key: string,
	title: string,
	userFacing: string,
	heading: string | null = null,
) => ({
	key,
	title,
	heading,
	userFacing,
	technical: null,
	adminSteps: [],
});

const SECTIONS: ReleaseNoteSection[] = [
	{
		section: "Added",
		entries: [
			entry(
				"ISS-102",
				"Demo CRM report screen: catalogue, campaign ROI",
				"CRM reports and campaign ROI: each report names its definition and refresh time.",
				"CRM reports",
			),
			entry(
				"ISS-122",
				"Publish the ROI slice and reports (ISS-102) to the dev site: workflow 178, routes 221/222",
				"The demo site now has the CRM report screen at /pages/reports.",
				"CRM report screen",
			),
			entry(
				"ISS-83",
				"Patient 360 screen for staff",
				"Staff open a patient's 360 record (/pages/patients?key=<HOP key>, ISS-78) from the staff menu.",
				"Patient 360 record",
			),
			entry(
				"ISS-90",
				"Campaign approval guard",
				"A campaign is sent for approval only when every item is filled.",
				"Campaign approval guard",
			),
			entry(
				"ISS-91",
				"Campaign approval guard, second slice",
				"A campaign is sent for approval only when every item is filled. ",
				"Campaign approval guard",
			),
			entry(
				"ISS-95",
				"Maker-checker on campaigns",
				"Approval follows SOD-RULE-MAKER-CHECKER at /hop/campaigns/sign.",
				"Maker-checker on campaigns",
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
				"Staff overview home page",
			),
		],
	},
];

describe("release notes a customer can be handed", () => {
	const view = customerNotes(SECTIONS);
	const lines = view.sections.flatMap((s) =>
		s.lines.flatMap((l) => (l.detail ? [l.line, l.detail] : [l.line])),
	);
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
		expect(lines.filter((l) => l === "Campaign approval guard")).toHaveLength(
			1,
		);
		expect(view.folded).toContainEqual({
			key: "ISS-91",
			why: "duplicate",
			into: ["ISS-90"],
		});
	});

	it("keeps a titled note as its title and its sentence, each whole, and holds it back where either names a handle", () => {
		const sentence =
			"Giờ đây, khi deploy lại thiết kế lên cửa hàng ePOD, sản phẩm đã có được cập nhật tại chỗ.";
		const titled = customerNotes([
			{
				section: "Fixed",
				entries: [
					entry(
						"ISS-3",
						"t",
						sentence,
						"Deploy lại lên ePOD không còn lỗi trùng SKU",
					),
					entry("ISS-4", "t", "Reports load faster.", "Faster reports (ISS-9)"),
					entry("ISS-5", "t", "Reports open.", "Reports at /pages/reports"),
				],
			},
		]);
		expect(titled.sections[0]?.lines).toEqual([
			{
				key: "ISS-3",
				line: "Deploy lại lên ePOD không còn lỗi trùng SKU",
				detail: sentence,
			},
			{ key: "ISS-4", line: "Faster reports", detail: "Reports load faster." },
		]);
		expect(titled.held).toEqual([
			{ key: "ISS-5", references: ["path /pages/reports"] },
		]);
	});

	it("holds back a note with no short title, or saying more than one sentence, until its writer fixes it (REQ-70 BC-3)", () => {
		const owed = customerNotes([
			{
				section: "Added",
				entries: [
					entry("ISS-6", "t", "Reports load faster."),
					entry(
						"ISS-7",
						"t",
						"Reports load faster. They also export.",
						"Faster reports",
					),
					entry(
						"ISS-8",
						"t",
						"Reports export to a spreadsheet.",
						"Report export",
					),
				],
			},
		]);
		expect(owed.sections[0]?.lines).toEqual([
			{
				key: "ISS-8",
				line: "Report export",
				detail: "Reports export to a spreadsheet.",
			},
		]);
		expect(owed.unwritten).toEqual([
			{ key: "ISS-6", why: "untitled" },
			{ key: "ISS-7", why: "not_one_sentence" },
		]);
	});

	it("reads a release that ended as it ended: an untitled note whole, a two-sentence note shown", () => {
		const ended = customerNotes(
			[
				{
					section: "Added",
					entries: [
						entry("ISS-6", "t", "Reports load faster."),
						entry(
							"ISS-7",
							"t",
							"Reports load faster. They also export.",
							"Faster reports",
						),
					],
				},
			],
			{ ended: true },
		);
		expect(ended.sections[0]?.lines).toEqual([
			{ key: "ISS-6", line: "Reports load faster.", detail: null },
			{
				key: "ISS-7",
				line: "Faster reports",
				detail: "Reports load faster. They also export.",
			},
		]);
		expect(ended.unwritten).toEqual([]);
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
