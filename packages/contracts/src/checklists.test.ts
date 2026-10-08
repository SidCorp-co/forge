import { describe, expect, it } from "vitest";
import { CHECKLISTS, ISSUE_READY_CHECKLIST, checklistsOn } from "./checklist-registry.js";
import {
	type Checklist,
	type ChecklistQuestion,
	checklistFormOf,
	checklistInputOf,
	checklistRefusals,
	checklistShape,
	countsAsPassed,
	defineChecklist,
	evaluateChecklist,
	gatedMoveStanding,
	parseAnswers,
} from "./checklists.js";
import { ISSUE_MACHINE } from "./issue-machine.js";
import { defineMachine } from "./state-machine.js";

const gates = { machine: "issue", from: ["draft"], to: "open" } as const;
const design = { flow: "issue-lifecycle", revision: 12, step: "ready-check" } as const;

const owner: ChecklistQuestion = {
	id: "owner",
	prompt: "Who owns it?",
	fix: "Name its owner.",
	answer: { kind: "text", maxLength: 80 },
	answeredBy: { by: "record", field: "ownerId" },
	need: { blocking: true },
};
const risk: ChecklistQuestion = {
	id: "risk",
	prompt: "How risky is it?",
	fix: "Pick a risk.",
	answer: {
		kind: "choice",
		options: [
			{ value: "low", label: "Low" },
			{ value: "high", label: "High" },
		],
	},
	answeredBy: { by: "mover" },
	need: { blocking: false, recommended: "low" },
};
const rollback: ChecklistQuestion = {
	id: "rollback",
	prompt: "How is it rolled back?",
	fix: "Say how it is undone.",
	answer: { kind: "text", maxLength: 200 },
	answeredBy: { by: "mover" },
	need: { blocking: true },
	when: { question: "risk", isOneOf: ["high"] },
};

/** A checklist whose shape is computed, so a test can change its questions freely. */
function checklistOf(questions: readonly ChecklistQuestion[]): Checklist {
	return defineChecklist({
		id: "probe",
		title: "Probe",
		gates,
		design,
		shapes: [checklistShape({ gates, questions })],
		questions,
	});
}

describe("one definition produces the form, the agent input and the check", () => {
	it("adds a question and sees all three change", () => {
		const before = checklistOf([owner, risk]);
		const after = checklistOf([
			owner,
			risk,
			{
				id: "notes",
				prompt: "What should the reviewer know?",
				fix: "Write it down.",
				answer: { kind: "text", maxLength: 100 },
				answeredBy: { by: "mover" },
				need: { blocking: true },
			},
		]);

		expect(checklistFormOf(before).fields.map((f) => f.name)).toEqual(["owner", "risk"]);
		expect(checklistFormOf(after).fields.map((f) => f.name)).toEqual(["owner", "risk", "notes"]);

		const props = (c: Checklist) =>
			Object.keys((checklistInputOf(c).properties ?? {}) as Record<string, unknown>);
		expect(props(before)).toEqual(["risk"]);
		expect(props(after)).toEqual(["risk", "notes"]);

		const record = { owner: { value: "Ana" } };
		expect(evaluateChecklist(before, { given: {}, record }).complete).toBe(true);
		const judged = evaluateChecklist(after, { given: {}, record });
		expect(judged.complete).toBe(false);
		expect(checklistRefusals(judged)).toEqual([
			expect.objectContaining({
				code: "CHECKLIST_INCOMPLETE",
				path: "/answers/notes",
				question: "notes",
				detail: "What should the reviewer know? Write it down.",
			}),
		]);
	});

	it("puts every question on the form and only the mover's in the input", () => {
		const c = checklistOf([owner, risk]);
		const [ownerField, riskField] = checklistFormOf(c).fields;
		expect(ownerField).toMatchObject({
			answeredBy: "record",
			recordField: "ownerId",
			path: "/answers/owner",
			blocking: true,
		});
		expect(riskField).toMatchObject({
			control: "choice",
			recommended: "low",
			blocking: false,
			options: [
				{ value: "low", label: "Low" },
				{ value: "high", label: "High" },
			],
		});
		expect(checklistInputOf(c)).toMatchObject({
			type: "object",
			additionalProperties: false,
			properties: { risk: { enum: ["low", "high"] } },
		});
	});
});

describe("evaluateChecklist", () => {
	const c = checklistOf([owner, risk, rollback]);

	it("stops only on a blocking gap nobody filled, naming the question and the record's reason", () => {
		const judged = evaluateChecklist(c, {
			given: {},
			record: { owner: { gap: "Nobody is named." } },
		});
		expect(judged.gaps).toEqual([
			{
				question: "owner",
				path: "/answers/owner",
				field: "ownerId",
				detail: "Who owns it? Nobody is named. Name its owner.",
			},
		]);
	});

	it("takes a non-blocking question's recommended answer, recorded as assumed", () => {
		const judged = evaluateChecklist(c, { given: {}, record: { owner: { value: "Ana" } } });
		expect(judged.complete).toBe(true);
		expect(judged.answers).toEqual([
			{ question: "owner", value: "Ana", provenance: "given", source: "record:ownerId" },
			{ question: "risk", value: "low", provenance: "assumed", source: "recommended" },
		]);
		expect(judged.notAsked).toEqual(["rollback"]);
	});

	it("asks a question only where its when holds", () => {
		const judged = evaluateChecklist(c, {
			given: { risk: "high" },
			record: { owner: { value: "Ana" } },
		});
		expect(judged.gaps.map((g) => g.question)).toEqual(["rollback"]);
		const answered = evaluateChecklist(c, {
			given: { risk: "high", rollback: "Revert the flag." },
			record: { owner: { value: "Ana" } },
		});
		expect(answered.complete).toBe(true);
		expect(answered.answers.find((a) => a.question === "rollback")).toMatchObject({
			provenance: "given",
			source: "mover",
		});
	});

	it("throws where the record reader answered nothing for a record question", () => {
		expect(() => evaluateChecklist(c, { given: {}, record: {} })).toThrow(
			/record reader answered nothing for `owner`/,
		);
	});
});

describe("parseAnswers refuses a wrong answer by name, never widening it", () => {
	const c = checklistOf([owner, risk]);
	const refused = (raw: unknown) => {
		const parsed = parseAnswers(c, raw);
		if (parsed.ok) throw new Error("expected a refusal");
		return parsed.refusals;
	};

	it("a question it does not ask", () => {
		expect(refused({ colour: "red" })).toEqual([
			expect.objectContaining({
				code: "CHECKLIST_ANSWER_INVALID",
				path: "/answers/colour",
				detail: "`colour` is not a question of the Probe checklist. The questions answered in the move are `risk`.",
			}),
		]);
	});

	it("a question the record answers", () => {
		expect(refused({ owner: "Ana" })).toEqual([
			expect.objectContaining({
				path: "/answers/owner",
				field: "ownerId",
				detail: '"Who owns it?" is answered by the item\'s own ownerId, not in the move. Name its owner.',
			}),
		]);
	});

	it("a value of the wrong kind, an empty one, and answers that are not an object", () => {
		expect(refused({ risk: "medium" })[0]?.detail).toBe(
			'"How risky is it?" takes one of `low`, `high`.',
		);
		expect(refused({ risk: "  " })[0]?.path).toBe("/answers/risk");
		expect(refused(["low"])[0]).toMatchObject({ path: "/answers" });
	});

	it("passes a choice exactly and a text answer trimmed", () => {
		expect(parseAnswers(c, { risk: "high" })).toEqual({ ok: true, answers: { risk: "high" } });
		expect(refused({ risk: " high " })[0]?.path).toBe("/answers/risk");
		const { when: _unasked, ...always } = rollback;
		const text = checklistOf([always]);
		expect(parseAnswers(text, { rollback: "  Revert it. " })).toEqual({
			ok: true,
			answers: { rollback: "Revert it." },
		});
		expect(parseAnswers(c, undefined)).toEqual({ ok: true, answers: {} });
	});
});

describe("declarations are refused at load", () => {
	it("a checklist whose shape its versions do not record", () => {
		expect(() =>
			defineChecklist({ id: "probe", title: "Probe", gates, design, shapes: ["00000000"], questions: [owner] }),
		).toThrow(/asks what no version records/);
	});

	it("a when on no earlier choice, and a recommended answer the question does not take", () => {
		const questions = [rollback];
		expect(() =>
			defineChecklist({ id: "p", title: "P", gates, design, shapes: [checklistShape({ gates, questions })], questions }),
		).toThrow(/not an earlier choice question/);
		const bad = [{ ...risk, need: { blocking: false, recommended: "medium" } } as ChecklistQuestion];
		expect(() =>
			defineChecklist({ id: "p", title: "P", gates, design, shapes: [checklistShape({ gates, questions: bad })], questions: bad }),
		).toThrow(/recommended answer is not an answer it takes/);
	});

	it("an edge naming the checklist guard without its checklist, or one gating another edge", () => {
		const base = {
			entity: "issue",
			shapes: ["x"],
			design: null,
			states: ["draft", "open", "closed"],
			initial: ["draft"],
			terminal: ["closed"],
			reasonRequired: [],
		} as const;
		expect(() =>
			defineMachine({
				...base,
				edges: [{ from: "draft", to: "open", act: "a", permission: null, guards: ["checklist"] }],
			}),
		).toThrow(/names the checklist guard and no checklist/);
		expect(() =>
			defineMachine({
				...base,
				edges: [
					{ from: "open", to: "closed", act: "a", permission: null, guards: ["checklist"], checklist: "issue_ready" },
				],
			}),
		).toThrow(/which gates issue `draft` → `open`/);
	});
});

describe("the registered issue-ready checklist", () => {
	it("gates the issue machine's draft to open, run by the kernel", () => {
		const edge = ISSUE_MACHINE.edges.find((e) => e.from === "draft" && e.to === "open");
		expect(edge).toMatchObject({ guards: ["admit", "checklist"], checklist: "issue_ready" });
		expect(checklistsOn(ISSUE_MACHINE)).toEqual([CHECKLISTS.issue_ready]);
		expect(ISSUE_READY_CHECKLIST.version).toBe(1);
	});

	it("asks hotfix obligations as an assumed answer, naming the open owner question", () => {
		const judged = evaluateChecklist(ISSUE_READY_CHECKLIST, {
			given: {},
			record: {
				requirement: { value: "REQ-34 at revision 2" },
				criteria: { value: "2 criteria" },
				design: { value: "None" },
			},
		});
		expect(judged.complete).toBe(true);
		expect(judged.answers.at(-1)).toEqual({
			question: "hotfix",
			value: "Not a hotfix: it fixes no production failure.",
			provenance: "assumed",
			source: "recommended",
			open: "0769f177-2941-42db-81a6-5346b00252bb",
		});
	});
});

describe("gated move standing", () => {
	it("reads a move recorded before checklists as no checklist, never counted as passing", () => {
		const before = gatedMoveStanding({ refused: false, checklistVersion: null });
		expect(before).toBe("no_checklist");
		expect(countsAsPassed(before)).toBe(false);
		expect(countsAsPassed(gatedMoveStanding({ refused: false, checklistVersion: 1 }))).toBe(true);
		expect(countsAsPassed(gatedMoveStanding({ refused: true, checklistVersion: 1 }))).toBe(false);
	});
});
