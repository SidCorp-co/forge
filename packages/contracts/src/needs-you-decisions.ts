// The needs-me read (REQ-41 BC-1, BC-2, BC-13; docs/proposals/chat-first.md, "Needs me"): the rows of
// the one Needs you read (`./needs-you.ts`) that are a decision only a person can make, grouped by
// the act they ask for, each with its question, a recommended answer and the buttons that answer
// it. The assistant answers "what waits on me" from this read and the project home draws it, so
// the two cannot disagree. A button is the act the record's own page performs, through the same
// route and under the same permission, run as the person who presses it (BC-9).

import { z } from "zod";
import {
	MOCKUP_ACCEPT_CONSEQUENCES,
	MOCKUP_KINDS,
	MOCKUP_LIMITS,
} from "./mockups.js";
import {
	NEEDS_YOU_AREAS,
	NEEDS_YOU_ENTITIES,
	type NeedsYouEntity,
} from "./needs-you.js";
import {
	decisionProposalSchema,
	NEEDS_YOU_TOPICS,
} from "./needs-you-proposal.js";

/** What a decision asks for, in the order the home and the chat list them. */
export const NEEDS_YOU_DECISION_GROUPS = [
	"answer",
	"approve",
	"accept",
	"verify",
] as const;
export type NeedsYouDecisionGroup = (typeof NEEDS_YOU_DECISION_GROUPS)[number];

export const NEEDS_YOU_DECISION_GROUP_LABELS: Record<
	NeedsYouDecisionGroup,
	string
> = {
	answer: "Answer a question",
	approve: "Approve or return",
	accept: "Accept what was delivered",
	verify: "Say whether it is fixed",
};

/**
 * Why a row the Needs you read lists for the viewer is not one of their decisions, so the reply can
 * say what it left out and why rather than drop it in silence. `own_work`: the viewer's own draft or
 * revision to finish. `work`: a task to carry out (criteria to check), not a choice.
 * `awaiting_proposal`: a draft the assistant has not yet proposed merging or dropping (BC-12).
 * `unreadable`: a record waiting on the viewer that no decision could be made of, named so it is
 * opened on its own page rather than dropped (the log says what broke).
 */
export const NEEDS_YOU_NOT_DECISION_REASONS = [
	"own_work",
	"work",
	"awaiting_proposal",
	"unreadable",
] as const;
export type NeedsYouNotDecisionReason =
	(typeof NEEDS_YOU_NOT_DECISION_REASONS)[number];

/**
 * The acts a decision's buttons perform, each the route the record's own page calls. `:projectId`,
 * `:key` (the record's key or id, as the route takes it) and the act's own ids are filled by core
 * when it builds the decision; the browser posts `body` to the filled path as the signed-in person.
 * `reason` acts take the reason the person types before the post is sent.
 */
export const DECISION_ACTS = {
	"question.answer": {
		path: "/api/questions/:questionId/answer",
		reason: false,
	},
	"revision.accept": {
		path: "/api/projects/:projectId/requirements/:key/revisions/:n/accept",
		reason: false,
	},
	"revision.return": {
		path: "/api/projects/:projectId/requirements/:key/revisions/:n/return",
		reason: true,
	},
	"requirement.agree": {
		path: "/api/projects/:projectId/requirements/:key/agree",
		reason: false,
	},
	"requirement.accept": {
		path: "/api/projects/:projectId/requirements/:key/accept",
		reason: false,
	},
	"requirement.drop": {
		path: "/api/projects/:projectId/requirements/:key/drop",
		reason: true,
	},
	"requirement.repin": {
		path: "/api/projects/:projectId/requirements/:key/repin",
		reason: false,
	},
	"requirement.defer": {
		path: "/api/projects/:projectId/requirements/:key/defer",
		reason: true,
	},
	"issue.admit": {
		path: "/api/issues/:issueId/transition",
		reason: false,
	},
	"suggestion.accept": {
		path: "/api/projects/:projectId/suggestions/:suggestionId/accept",
		reason: false,
	},
	"suggestion.reject": {
		path: "/api/projects/:projectId/suggestions/:suggestionId/reject",
		reason: true,
	},
	"feedback.verify": {
		path: "/api/projects/:projectId/feedback/:key/verify",
		reason: false,
	},
	"feedback.reopen": {
		path: "/api/projects/:projectId/feedback/:key/reopen",
		reason: true,
	},
	"release.cut": {
		path: "/api/projects/:projectId/release-batches",
		reason: false,
	},
	"release.decide": {
		path: "/api/projects/:projectId/release-batches/:runId/approvals/:approvalId/decision",
		reason: false,
	},
	"preview.approve": {
		path: "/api/previews/:previewId/approve",
		reason: false,
	},
	"design.decide": {
		path: "/api/projects/:projectId/workflows/:workflowId/design/decision",
		reason: false,
	},
	"mockup.accept": {
		path: "/api/projects/:projectId/mockups/:mockupKey/accept",
		reason: false,
	},
	"mockup.return": {
		path: "/api/projects/:projectId/mockups/:mockupKey/return",
		reason: true,
	},
	"design.repin": {
		path: "/api/projects/:projectId/workflows/:workflowId/design/repins",
		reason: false,
	},
	"lesson.approve": {
		path: "/api/projects/:projectId/lessons/:lessonKey/approve",
		reason: false,
	},
	"lesson.reject": {
		path: "/api/projects/:projectId/lessons/:lessonKey/reject",
		reason: true,
	},
	"lesson.retire": {
		path: "/api/projects/:projectId/lessons/:lessonKey/retire",
		reason: true,
	},
	"lesson.keep": {
		path: "/api/projects/:projectId/lessons/:lessonKey/keep",
		reason: false,
	},
	"lesson.confusion": {
		path: "/api/projects/:projectId/lessons/confusions/:confusionId/decide",
		reason: false,
	},
} as const;
export type DecisionAct = keyof typeof DECISION_ACTS;
export const DECISION_ACT_NAMES = Object.keys(DECISION_ACTS) as [
	DecisionAct,
	...DecisionAct[],
];

const PATH_PARAM = /:([A-Za-z]+)/g;

/** The names an act's path needs filled, in order. */
export const decisionActParams = (act: DecisionAct): string[] =>
	[...DECISION_ACTS[act].path.matchAll(PATH_PARAM)].map((m) => m[1] as string);

/**
 * An act's path with its params filled, or the names it is missing. A value is URL-encoded, and one
 * that is empty is missing: a button never posts to a path with a hole in it.
 */
export function decisionPath(
	act: DecisionAct,
	params: Readonly<Record<string, string | number | undefined>>,
): { ok: true; path: string } | { ok: false; missing: string[] } {
	const missing = decisionActParams(act).filter(
		(p) => params[p] === undefined || String(params[p]) === "",
	);
	if (missing.length) return { ok: false, missing };
	return {
		ok: true,
		path: DECISION_ACTS[act].path.replace(PATH_PARAM, (_, p: string) =>
			encodeURIComponent(String(params[p])),
		),
	};
}

const LIMITS = {
	question: 2000,
	label: 120,
	why: 600,
	effect: 300,
	decisions: 200,
} as const;

/** One button: what it says, what pressing it changes, and the post it sends. */
export const decisionAnswerSchema = z.strictObject({
	/** Stable within the decision: an option id, or the act's own name. */
	id: z.string().min(1).max(100),
	label: z.string().min(1).max(LIMITS.label),
	act: z.enum(DECISION_ACT_NAMES),
	/** The filled route; never one with a `:param` left in it. */
	path: z
		.string()
		.startsWith("/api/")
		.refine((p) => !p.includes("/:"), {
			message: "a decision's path has every param filled",
		}),
	body: z.record(z.string(), z.unknown()).nullable(),
	/** The person types a reason before it is sent (a return, a drop, a reopen). */
	needsReason: z.boolean(),
	/**
	 * It says no to what is asked: a return, a reject, a drop, a defer, a reopen. A page's Decline
	 * presses this answer and no other; a decision none of whose acts says no has none (ISS-539).
	 */
	declines: z.boolean(),
	/** What pressing it changes, read before pressing (`WaitingOn.effect`'s rule). */
	effect: z.string().max(LIMITS.effect).nullable(),
	recommended: z.boolean(),
});
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;

/** The recommended answer and where the recommendation came from. */
export const decisionRecommendationSchema = z.strictObject({
	/** The `id` of the answer it recommends. */
	answerId: z.string().min(1).max(100),
	why: z.string().min(1).max(LIMITS.why),
	/** Who recommended it: the question's asker, the assistant's proposal, Forge's own rule, the steward (REQ-48 BC-11). */
	by: z.enum(["asker", "assistant", "rule", "steward"]),
});

/** One decision only a person can make (BC-1), with what BC-2 asks of it. */
export const needsYouDecisionSchema = z
	.strictObject({
		/** Unique within the read: what a page's peek and selection name it by. */
		id: z.string().min(1).max(300),
		group: z.enum(NEEDS_YOU_DECISION_GROUPS),
		area: z.enum(NEEDS_YOU_AREAS),
		entity: z.enum(NEEDS_YOU_ENTITIES),
		/** The row's key, as the Needs you read lists it. */
		key: z.string().min(1).max(200),
		title: z.string().max(500),
		/**
		 * The record that opens to decide it, as `ui.open` takes it (it may be the row's own key, or the
		 * issue a requirement waits on); null where no record holds it, a question a run asked on nothing.
		 */
		opens: z
			.strictObject({
				kind: z.enum([
					"issue",
					"requirement",
					"feedback",
					"workflow",
					"release",
					"lesson",
				]),
				key: z.string().min(1).max(200),
			})
			.nullable(),
		/** What is asked, in the asker's words, or Forge's for an approval. */
		question: z.string().min(1).max(LIMITS.question),
		recommended: decisionRecommendationSchema.nullable(),
		/** Set exactly when `recommended` is null: why none is offered (the asker gave none). */
		noRecommendation: z.string().min(1).max(LIMITS.why).nullable(),
		answers: z.array(decisionAnswerSchema).min(1).max(8),
		touchedAt: z.iso.datetime().nullable(),
		/** The item it decides reads stuck (`steward.ts:StuckReading`): it leads the list. */
		stuck: z.boolean(),
		/** When the act falls due (`StandingTimes.dueAt`), null where it never does. */
		dueAt: z.iso.datetime().nullable(),
		/** The page group it is read under (`needs-you-proposal.ts`). */
		topic: z.enum(NEEDS_YOU_TOPICS),
		/** What the agent proposes, where an agent proposed it; null on a person's question or sign-off. */
		proposal: decisionProposalSchema.nullable(),
		/**
		 * A mockup decision's preview and standing (REQ-49 BC-7): its key, the route serving its bytes, which
		 * `features/mockups` `MockupPreview` draws in the row and the peek, its kind and name, its round
		 * and the mockup it revises, the comments still open on it, and what accepting it does. Absent on
		 * every other decision.
		 */
		mockup: z
			.strictObject({
				/** Its MK-n, which its item's page opens full screen (`?mockup=MK-n&full=1`). */
				key: z.string().regex(/^MK-\d{1,9}$/),
				url: z.string().startsWith("/api/"),
				kind: z.enum(MOCKUP_KINDS),
				name: z.string().min(1).max(MOCKUP_LIMITS.nameChars),
				round: z.int().min(1),
				revises: z.string().max(200).nullable(),
				openComments: z.int().min(0),
				consequence: z.enum(MOCKUP_ACCEPT_CONSEQUENCES),
			})
			.optional(),
	})
	.superRefine((d, ctx) => {
		if ((d.recommended === null) === (d.noRecommendation === null)) {
			ctx.addIssue({
				code: "custom",
				path: ["noRecommendation"],
				message:
					"a decision either recommends an answer or says why it cannot, never both or neither",
			});
		}
		const ids = d.answers.map((a) => a.id);
		if (new Set(ids).size !== ids.length) {
			ctx.addIssue({
				code: "custom",
				path: ["answers"],
				message: "answer ids are unique within a decision",
			});
		}
		const declining = d.answers.filter((a) => a.declines);
		if (declining.length > 1) {
			ctx.addIssue({
				code: "custom",
				path: ["answers"],
				message: "at most one answer declines a decision",
			});
		}
		for (const a of declining.filter((x) => !x.needsReason)) {
			ctx.addIssue({
				code: "custom",
				path: ["answers", d.answers.indexOf(a), "needsReason"],
				message: "a declining answer asks why: it takes a reason",
			});
		}
		const marked = d.answers.filter((a) => a.recommended).map((a) => a.id);
		const want = d.recommended ? [d.recommended.answerId] : [];
		if (marked.length !== want.length || marked[0] !== want[0]) {
			ctx.addIssue({
				code: "custom",
				path: ["answers"],
				message:
					"exactly the recommended answer is marked recommended, and it is one of the answers",
			});
		}
	});
export type NeedsYouDecision = z.infer<typeof needsYouDecisionSchema>;

/** `GET /api/projects/:id/needs-you/decisions` and the assistant's needs-me tool: one read, two doors. */
export const needsYouDecisionsSchema = z.strictObject({
	generatedAt: z.iso.datetime(),
	/** Group by group in `NEEDS_YOU_DECISION_GROUPS` order, oldest first inside a group. */
	decisions: z.array(needsYouDecisionSchema).max(LIMITS.decisions),
	/** How many decisions there are in all; `decisions` holds the first `LIMITS.decisions`. */
	total: z.int().min(0),
	/** The viewer's Needs you rows that are not decisions, by why, so a reply names what it left out. */
	notDecisions: z.array(
		z.strictObject({
			reason: z.enum(NEEDS_YOU_NOT_DECISION_REASONS),
			count: z.int().min(1),
			keys: z.array(z.string()).max(20),
		}),
	),
});
export type NeedsYouDecisions = z.infer<typeof needsYouDecisionsSchema>;

/** One project's part of /attention: its Needs you `total` and the first `NEEDS_YOU_PERSON_CAP` decisions. */
export interface NeedsYouProjectDecisions {
	projectSlug: string;
	projectName: string;
	total: number;
	decisions: NeedsYouDecision[];
}

/**
 * The order decisions are listed in (REQ-48 BC-11): one carrying a stuck item first, then the
 * soonest due, then group, then oldest first, so what holds work up leads.
 */
export function byDecisionOrder(
	a: NeedsYouDecision,
	b: NeedsYouDecision,
): number {
	if (a.stuck !== b.stuck) return a.stuck ? -1 : 1;
	if (a.dueAt !== b.dueAt) {
		if (a.dueAt === null) return 1;
		if (b.dueAt === null) return -1;
		return a.dueAt.localeCompare(b.dueAt);
	}
	const g =
		NEEDS_YOU_DECISION_GROUPS.indexOf(a.group) -
		NEEDS_YOU_DECISION_GROUPS.indexOf(b.group);
	if (g !== 0) return g;
	return (a.touchedAt ?? "").localeCompare(b.touchedAt ?? "");
}

/**
 * The said act keys a person decides, each one a decision the needs-me read builds (BC-11): an
 * answer to a question, an approval, an acceptance, a verify. A row whose act is none of these is
 * work an agent takes, never Needs you, so every list and the needs-me read hold the same rows.
 */
export const DECISION_ACT_KEYS: ReadonlySet<string> = new Set([
	"issues.standing.act.answer",
	"issues.standing.act.answerOther",
	"issues.standing.act.decide",
	"issues.standing.act.supply",
	"standing.act.answerSteward",
	"standing.act.acceptR",
	"standing.act.agreeR",
	"standing.act.check",
	"standing.act.approveOrReturn",
	"designs.act.approveOrReturn",
	"standing.act.confirmAnswer",
	"standing.act.verifyFix",
	"standing.act.verifyFixIn",
	"standing.act.promoteDraft",
	"standing.act.promoteDrafts",
	"standing.act.updateToDesign",
	"standing.act.updateToContract",
	"standing.act.reviewBreakdown",
	"standing.act.reviewSuggestedRevision",
	"designs.act.repinBatch",
]);

type SaidAct = {
	key: string;
	vars?: Readonly<Record<string, unknown>> | undefined;
};

const isSaidAct = (v: unknown): v is SaidAct =>
	typeof v === "object" && v !== null && "key" in v;

/**
 * Whether a wait's act is a person's decision: a requirement's wait on one of its issues reads the
 * issue's act, and several acts said as one (`standing.acts`) are a decision when each of them is.
 */
export function isDecisionAct(act: SaidAct): boolean {
	const inner = act.key === "standing.act.onIssue" ? act.vars?.act : undefined;
	if (isSaidAct(inner)) return isDecisionAct(inner);
	const many = act.key === "standing.acts" ? act.vars?.acts : undefined;
	if (Array.isArray(many))
		return (
			many.length > 0 && many.every((a) => isSaidAct(a) && isDecisionAct(a))
		);
	return DECISION_ACT_KEYS.has(act.key);
}

/**
 * The said act keys a person decides only on the record that owes them: a release's cut is the
 * admin's decision on the release itself (`release.cut`), so the requirement or feedback item that
 * waits on that cut reads it as waiting, and the one decision stays the release's (REQ-48 BC-11).
 */
const DECISION_ACT_KEYS_ON: Partial<
	Record<NeedsYouEntity, ReadonlySet<string>>
> = {
	release: new Set(["standing.act.cut"]),
};

/** Whether a wait's act is a person's decision on a row of `entity` (`isDecisionAct`, and its own acts). */
export function isDecisionActOn(entity: NeedsYouEntity, act: SaidAct): boolean {
	return (
		isDecisionAct(act) || (DECISION_ACT_KEYS_ON[entity]?.has(act.key) ?? false)
	);
}

/** The first `cap` decisions a person is shown and how many more wait behind them, never dropped (BC-11). */
export function capDecisions<T>(
	decisions: readonly T[],
	cap: number,
): { shown: T[]; more: number } {
	return {
		shown: decisions.slice(0, cap),
		more: Math.max(0, decisions.length - cap),
	};
}
