import { describe, expect, it } from "vitest";
import {
	byDecisionOrder,
	DECISION_ACTS,
	type DecisionAnswer,
	decisionActParams,
	decisionPath,
	isDecisionAct,
	isDecisionActOn,
	type NeedsYouDecision,
	needsYouDecisionSchema,
	needsYouDecisionsSchema,
} from "./needs-you-decisions.js";

const answer = (over: Partial<DecisionAnswer>): DecisionAnswer => ({
	id: "a",
	label: "Use the recommended reading",
	act: "question.answer",
	path: "/api/questions/q-1/answer",
	body: { round: 1, optionId: "a" },
	needsReason: false,
	declines: false,
	effect: null,
	recommended: false,
	...over,
});

// ISS-451 on forge-dev, 2026-10-09: the question REQ-34 waits on, as the mockup answers it
const iss451: NeedsYouDecision = {
	group: "answer",
	area: "requirements",
	entity: "requirement",
	key: "REQ-34",
	title: "Every lifecycle step is a checklist contract",
	opens: { kind: "requirement", key: "REQ-34" },
	question:
		'REQ-34 lists "hotfix obligations" on the issue-ready checklist but never says what they are. Which reading holds?',
	recommended: {
		answerId: "a",
		why: "Issue lifecycle r12 draws it: a hotfix names its revert and its follow-up.",
		by: "asker",
	},
	noRecommendation: null,
	answers: [
		answer({ id: "a", recommended: true }),
		answer({
			id: "b",
			label: "Another reading",
			body: { round: 1, optionId: "b" },
		}),
	],
	touchedAt: "2026-10-07T17:00:00.000Z",
	stuck: false,
	dueAt: null,
	id: "question:q-1",
	topic: "question",
	proposal: null,
};

describe("a decision shows its question, a recommended answer and a button (BC-2)", () => {
	it("takes the mockup's ISS-451 decision", () => {
		expect(needsYouDecisionSchema.safeParse(iss451).success).toBe(true);
	});

	it("refuses one that neither recommends nor says why it cannot", () => {
		const r = needsYouDecisionSchema.safeParse({
			...iss451,
			recommended: null,
			answers: [answer({ id: "a" })],
		});
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error?.issues)).toContain(
			"either recommends an answer or says why it cannot",
		);
	});

	it("takes a question a run asked on nothing, which opens no record, and refuses an empty one", () => {
		expect(
			needsYouDecisionSchema.safeParse({ ...iss451, opens: null }).success,
		).toBe(true);
		expect(
			needsYouDecisionSchema.safeParse({
				...iss451,
				opens: { kind: "requirement", key: "" },
			}).success,
		).toBe(false);
	});

	it("takes one whose asker gave no recommendation, saying so", () => {
		const r = needsYouDecisionSchema.safeParse({
			...iss451,
			recommended: null,
			noRecommendation: "The run that asked gave no recommended answer.",
			answers: [answer({ id: "a" })],
		});
		expect(r.success).toBe(true);
	});

	it("refuses a recommendation that is not one of its buttons", () => {
		const r = needsYouDecisionSchema.safeParse({
			...iss451,
			recommended: { ...iss451.recommended, answerId: "z" },
		});
		expect(r.success).toBe(false);
	});

	it("refuses a button whose path still has a hole in it", () => {
		const r = needsYouDecisionSchema.safeParse({
			...iss451,
			answers: [
				answer({
					id: "a",
					recommended: true,
					path: "/api/questions/:questionId/answer",
				}),
			],
		});
		expect(r.success).toBe(false);
	});

	it("refuses a declining answer that does not ask why, and two answers that each decline (ISS-539)", () => {
		const no = (over: Partial<DecisionAnswer>) =>
			answer({
				act: "revision.return",
				path: "/api/projects/p/requirements/REQ-1/revisions/2/return",
				body: {},
				declines: true,
				needsReason: true,
				...over,
			});
		const ok = needsYouDecisionSchema.safeParse({
			...iss451,
			answers: [answer({ id: "a", recommended: true }), no({ id: "b" })],
		});
		expect(ok.success).toBe(true);
		const silent = needsYouDecisionSchema.safeParse({
			...iss451,
			answers: [
				answer({ id: "a", recommended: true }),
				no({ id: "b", needsReason: false }),
			],
		});
		expect(JSON.stringify(silent.error?.issues)).toContain(
			"a declining answer asks why",
		);
		const twice = needsYouDecisionSchema.safeParse({
			...iss451,
			answers: [answer({ id: "a", recommended: true }), no({ id: "b" }), no({ id: "c" })],
		});
		expect(JSON.stringify(twice.error?.issues)).toContain(
			"at most one answer declines a decision",
		);
	});

	it("refuses a decision with no button at all", () => {
		expect(
			needsYouDecisionSchema.safeParse({ ...iss451, answers: [] }).success,
		).toBe(false);
	});
});

describe("the acts behind the buttons are the page's own routes", () => {
	it("fills every param, URL-encoded", () => {
		const p = decisionPath("revision.accept", {
			projectId: "p",
			key: "REQ-34",
			n: 2,
		});
		expect(p).toEqual({
			ok: true,
			path: "/api/projects/p/requirements/REQ-34/revisions/2/accept",
		});
		expect(
			decisionPath("feedback.verify", { projectId: "p", key: "FB 1" }),
		).toEqual({
			ok: true,
			path: "/api/projects/p/feedback/FB%201/verify",
		});
	});

	it("names what is missing rather than post to a path with a hole", () => {
		expect(
			decisionPath("release.decide", { projectId: "p", runId: "" }),
		).toEqual({
			ok: false,
			missing: ["runId", "approvalId"],
		});
	});

	it("asks a reason for every act that drops, returns, rejects or reopens", () => {
		for (const act of [
			"revision.return",
			"requirement.drop",
			"suggestion.reject",
			"feedback.reopen",
		] as const)
			expect(DECISION_ACTS[act].reason).toBe(true);
		expect(decisionActParams("question.answer")).toEqual(["questionId"]);
	});
});

// dev.281, 2026-10-22: REQ-18's re-pin decision offered a one-click button its route refused
// REQUIREMENT_SIGNOFF_REASON_REQUIRED, so the press could never succeed (REQ-41 BC-2)
describe("a button declares the reason its route needs", () => {
	const req18 = (needsReason: boolean): NeedsYouDecision => ({
		...iss451,
		group: "approve",
		key: "REQ-18",
		opens: { kind: "requirement", key: "REQ-18" },
		question:
			"Follow the approved designs and contracts in REQ-18 at revision 1?",
		recommended: {
			answerId: "repin",
			why: "A new baseline pins the approved versions; the wording and criteria stay as they are.",
			by: "rule",
		},
		answers: [
			{
				id: "repin",
				label: "Update to the approved versions",
				act: "requirement.repin",
				path: "/api/projects/p/requirements/REQ-18/repin",
				body: { revision: 1 },
				needsReason,
				declines: false,
				effect: null,
				recommended: true,
			},
		],
		id: "requirement:REQ-18",
	});

	it("refuses the re-pin dev offered with no reason, naming the answer", () => {
		const r = needsYouDecisionSchema.safeParse(req18(false));
		expect(r.success).toBe(false);
		expect(r.error?.issues).toEqual([
			expect.objectContaining({
				path: ["answers", 0, "needsReason"],
				message:
					"a requirement.repin answer takes a reason: its route refuses a press without one",
			}),
		]);
		expect(needsYouDecisionSchema.safeParse(req18(true)).success).toBe(true);
	});

	it("names the agree and the re-pin among the acts that take a reason", () => {
		expect(DECISION_ACTS["requirement.agree"].reason).toBe(true);
		expect(DECISION_ACTS["requirement.repin"].reason).toBe(true);
		expect(DECISION_ACTS["requirement.accept"].reason).toBe(false);
	});
});

describe("the read", () => {
	it("lists groups in order, oldest first inside one", () => {
		const approve = {
			...iss451,
			group: "approve" as const,
			touchedAt: "2026-10-01T00:00:00.000Z",
		};
		const older = {
			...iss451,
			key: "REQ-35",
			touchedAt: "2026-10-06T00:00:00.000Z",
		};
		expect(
			[approve, iss451, older].sort(byDecisionOrder).map((d) => d.key),
		).toEqual(["REQ-35", "REQ-34", "REQ-34"]);
		expect([approve, iss451].sort(byDecisionOrder)[1]?.group).toBe("approve");
	});

	it("says what it left out, by why", () => {
		const r = needsYouDecisionsSchema.safeParse({
			generatedAt: "2026-10-09T12:00:00.000Z",
			decisions: [iss451],
			total: 1,
			notDecisions: [
				{ reason: "awaiting_proposal", count: 11, keys: ["REQ-29"] },
			],
		});
		expect(r.success).toBe(true);
		const bad = needsYouDecisionsSchema.safeParse({
			generatedAt: "2026-10-09T12:00:00.000Z",
			decisions: [],
			total: 0,
			notDecisions: [{ reason: "applies_itself", count: 13, keys: [] }],
		});
		expect(bad.success).toBe(false);
	});
});

describe("a release's cut (REQ-48 BC-11)", () => {
	const cut = { key: "standing.act.cut", vars: { v: "0.4.0", more: null } };

	it("is the admin's decision on the release, posted through the release page's own door", () => {
		expect(isDecisionActOn("release", cut)).toBe(true);
		expect(decisionPath("release.cut", { projectId: "p" })).toEqual({
			ok: true,
			path: "/api/projects/p/release-batches",
		});
	});

	it("is no decision on a requirement or feedback item that waits on it", () => {
		expect(isDecisionAct(cut)).toBe(false);
		expect(isDecisionActOn("requirement", cut)).toBe(false);
		expect(isDecisionActOn("feedback", cut)).toBe(false);
	});
});
