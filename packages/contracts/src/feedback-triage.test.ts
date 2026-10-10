// The triage checklist as a triage carries it (REQ-34 BC-1, BC-6; Feedback lifecycle r14
// triage-check): a triage missing an answer is refused naming the question, and a bug naming its
// criterion is complete with three answers.

import { describe, expect, it } from "vitest";
import { FEEDBACK_TRIAGE_CHECKLIST } from "./checklist-registry.js";
import { checklistRefusals, evaluateChecklist, parseAnswers, type RecordAnswers } from "./checklists.js";
import {
	criterionAnswerOf,
	isShortForm,
	SHORT_FORM_RULE,
	triageAnswersOf,
	triageAnswersSchema,
	triageDerivedOf,
	triageRouteOf,
} from "./feedback-triage.js";
import { FEEDBACK_MACHINE } from "./feedback-machine.js";
import { edgeBetween } from "./state-machine.js";

const record = (kind: string): RecordAnswers => ({
	kind: { value: kind },
	requirement: { value: "REQ-3" },
});

/** The checklist judged as the kernel judges it: the answers parsed, then evaluated with the record. */
function judge(kind: "bug" | "idea", route: "issue" | "new_requirement" | undefined, answers: unknown) {
	const parsed = parseAnswers(FEEDBACK_TRIAGE_CHECKLIST, triageAnswersOf({ route, answers }));
	if (!parsed.ok) return { refusals: parsed.refusals, evaluation: null };
	const evaluation = evaluateChecklist(FEEDBACK_TRIAGE_CHECKLIST, {
		given: parsed.answers,
		record: record(kind),
		derived: triageDerivedOf({ kind, route, answers }),
	});
	return { refusals: checklistRefusals(evaluation), evaluation };
}

describe("the feedback triage checklist", () => {
	it("asks the six answers the approved design names, in its order", () => {
		expect(FEEDBACK_TRIAGE_CHECKLIST.questions.map((q) => q.id)).toEqual([
			"kind",
			"requirement",
			"criterion",
			"severity",
			"reproduced",
			"route",
		]);
		expect(FEEDBACK_TRIAGE_CHECKLIST.questions.every((q) => q.need.blocking)).toBe(true);
	});

	it("gates every edge into triaged, and no other", () => {
		for (const from of ["new", "reopened"] as const) {
			expect(edgeBetween(FEEDBACK_MACHINE, from, "triaged")?.checklist).toBe("feedback_triage");
		}
		expect(edgeBetween(FEEDBACK_MACHINE, "triaged", "verified")?.checklist).toBeUndefined();
		expect(edgeBetween(FEEDBACK_MACHINE, "new", "declined")?.checklist).toBeUndefined();
	});
});

describe("a triage missing an answer (BC-1)", () => {
	it("is refused once per missing question, each naming it on its own path", () => {
		const { refusals } = judge("idea", undefined, {});
		expect(refusals.map((r) => r.path)).toEqual([
			"/answers/criterion",
			"/answers/severity",
			"/answers/reproduced",
			"/answers/route",
		]);
		expect(refusals.every((r) => r.code === "CHECKLIST_INCOMPLETE")).toBe(true);
		expect(refusals[0]?.detail).toMatch(/^Which business criterion does it violate, or none\? /);
		expect(refusals[3]?.detail).toMatch(/^Which route does it take\? /);
	});

	it("names only what is still missing once the rest is answered", () => {
		const { refusals } = judge("bug", "issue", { criterion: "none", severity: "high" });
		expect(refusals.map((r) => r.path)).toEqual(["/answers/reproduced"]);
	});

	it("is complete with every answer of the full form, the route given", () => {
		const { refusals, evaluation } = judge("idea", "new_requirement", {
			criterion: "none",
			severity: "low",
			reproduced: "Not a defect: nothing to reproduce.",
		});
		expect(refusals).toEqual([]);
		expect(evaluation?.answers.find((a) => a.question === "route")?.value).toBe("new_requirement");
	});

	it("refuses a severity the checklist does not offer by name", () => {
		const { refusals } = judge("bug", "issue", { criterion: "none", severity: "urgent", reproduced: "x" });
		expect(refusals[0]).toMatchObject({ code: "CHECKLIST_ANSWER_INVALID", path: "/answers/severity" });
	});
});

describe("the short form (BC-6)", () => {
	const three = { criterion: "REQ-3 BC-2", severity: "high", reproduced: "On dev.220: the filter resets on reload." };

	it("triages a bug against a named criterion with its three answers, taking the issue route", () => {
		expect(isShortForm("bug", three)).toBe(true);
		expect(triageRouteOf({ kind: "bug", route: undefined, answers: three })).toBe("issue");
		const { refusals, evaluation } = judge("bug", undefined, three);
		expect(refusals).toEqual([]);
		expect(evaluation?.complete).toBe(true);
	});

	it("records the route it gives as derived by the short form, and a route the triager sent as theirs", () => {
		const route = (e: ReturnType<typeof judge>["evaluation"]) => e?.answers.find((a) => a.question === "route");
		expect(route(judge("bug", undefined, three).evaluation)).toEqual({
			question: "route",
			value: "issue",
			provenance: "given",
			source: `derived:${SHORT_FORM_RULE}`,
		});
		expect(route(judge("bug", "issue", three).evaluation)).toMatchObject({ value: "issue", source: "mover" });
		expect(triageDerivedOf({ kind: "idea", route: undefined, answers: three })).toEqual({});
	});

	it("is not taken by an idea, nor by a bug that names no criterion", () => {
		expect(isShortForm("idea", three)).toBe(false);
		expect(isShortForm("bug", { ...three, criterion: "none" })).toBe(false);
		expect(judge("bug", undefined, { ...three, criterion: "none" }).refusals.map((r) => r.path)).toEqual([
			"/answers/route",
		]);
	});
});

describe("a criterion answer", () => {
	it("reads none, or a REQ-n BC-m reference, and nothing else", () => {
		expect(criterionAnswerOf("none")).toEqual({ none: true });
		expect(criterionAnswerOf(" REQ-34 BC-6 ")).toEqual({ none: false, requirement: "REQ-34", code: "BC-6" });
		for (const text of ["None", "REQ-34", "BC-6", "REQ-34 BC-6 and BC-7", "req-34 bc-6", "REQ-0 BC-1"]) {
			expect(criterionAnswerOf(text)).toBeNull();
		}
	});
});

describe("the answers a triage sends", () => {
	it("are the checklist's questions the triager answers, the route left to the triage's own field", () => {
		expect(Object.keys(triageAnswersSchema.shape).sort()).toEqual(["criterion", "reproduced", "severity"]);
		expect(triageAnswersSchema.safeParse({ route: "issue" }).success).toBe(false);
	});

	it("hand answers that are not an object on as sent, for the check to refuse by name", () => {
		expect(triageAnswersOf({ route: "issue", answers: "all good" })).toBe("all good");
		const { refusals } = judge("bug", "issue", "all good");
		expect(refusals[0]).toMatchObject({ code: "CHECKLIST_ANSWER_INVALID", path: "/answers" });
	});
});
