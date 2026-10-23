// What a decision proposes, as the one Needs you page reads it (REQ-48 BC-11): the agent's proposal
// as a verb and its object, whether the agent recommends it or asks the person to check first, the
// tags a row carries, what approving changes, why, what the reporter said, and the records that
// move. Core builds it from the record the decision is on (a suggestion's payload, a re-pin's plan);
// a decision a person asked, a question say, carries none and reads by its question.

import { z } from "zod";
import { cutAtWord } from "./title-text.js";

/**
 * Where a decision sits on the page, each a group under its own heading. `feedback`: how the agent
 * proposes to handle a report, and a fix to verify. `breakdown`: issues proposed for an agreed
 * requirement. `design_update`: designs built on a changed design, moved to follow it. The rest are
 * a person's question, a requirement's sign-off, a design, a release, a mockup and a preview.
 */
export const NEEDS_YOU_TOPICS = [
	"feedback",
	"breakdown",
	"design_update",
	"mockup",
	"requirement",
	"design",
	"release",
	"preview",
	"question",
] as const;
export type NeedsYouTopic = (typeof NEEDS_YOU_TOPICS)[number];

/** The topics the page offers a chip for; every other topic is read under All. */
export const NEEDS_YOU_TOPIC_CHIPS = [
	"feedback",
	"breakdown",
	"design_update",
	"mockup",
] as const satisfies readonly NeedsYouTopic[];

/**
 * What approving makes, counted so a bulk approve states its consequences before it acts:
 * "Approving makes 19 new issues · 3 requirement revisions · 5 closed".
 */
export const NEEDS_YOU_YIELDS = [
	"new_issue",
	"revision",
	"closed",
	"design_update",
	"draft_issue",
	"approved",
] as const;
export type NeedsYouYield = (typeof NEEDS_YOU_YIELDS)[number];

export const PROPOSAL_TAG_TONES = ["plain", "ok", "warn", "danger"] as const;

const LIMITS = {
	tags: 8,
	lines: 12,
	rows: 60,
	verb: 120,
	what: 600,
	tag: 120,
	line: 600,
	label: 60,
	value: 4000,
	said: 20_000,
	cell: 600,
} as const;

export const decisionProposalSchema = z.strictObject({
	/** The act proposed, a verb and its object's name: "New issue", "Duplicate of FB-117", "Follow r17". */
	verb: z.string().min(1).max(LIMITS.verb),
	/** What it acts on or why, in the agent's words: the new issue's title, the decline's note. */
	what: z.string().max(LIMITS.what),
	/** The agent recommends approving as proposed; false asks the person to check first. */
	recommends: z.boolean(),
	tags: z
		.array(
			z.strictObject({
				text: z.string().min(1).max(LIMITS.tag),
				tone: z.enum(PROPOSAL_TAG_TONES),
			}),
		)
		.max(LIMITS.tags),
	/** What approving changes, each one line, read before approving. */
	consequences: z.array(z.string().min(1).max(LIMITS.line)).max(LIMITS.lines),
	/** Why: the cause, the fix, whether it was reproduced, the closest item, the criterion. */
	why: z
		.array(
			z.strictObject({
				label: z.string().min(1).max(LIMITS.label),
				value: z.string().min(1).max(LIMITS.value),
			}),
		)
		.max(LIMITS.lines),
	/** What the reporter said, whole; null where nobody reported it. */
	said: z.string().max(LIMITS.said).nullable(),
	/** The records that move, as rows: the designs that follow, the issues proposed. */
	table: z
		.strictObject({
			title: z.string().min(1).max(LIMITS.label),
			columns: z.array(z.string().min(1).max(LIMITS.label)).min(2).max(4),
			rows: z
				.array(z.array(z.string().max(LIMITS.cell)).min(2).max(4))
				.max(LIMITS.rows),
		})
		.nullable(),
	yields: z
		.array(
			z.strictObject({
				kind: z.enum(NEEDS_YOU_YIELDS),
				n: z.int().min(1),
			}),
		)
		.max(NEEDS_YOU_YIELDS.length),
});
export type DecisionProposal = z.infer<typeof decisionProposalSchema>;

/** Prose kept to `max`, its lines kept: cut at the last space that fits, with an ellipsis. */
function cutKeepingLines(text: string, max: number): string {
	if (text.length <= max) return text;
	const space = text.lastIndexOf(" ", max - 1);
	return `${text.slice(0, space > 0 ? space : max - 1)}…`;
}

/**
 * A proposal fitted to the page's bounds, every field cut at a word with an ellipsis rather than the
 * whole decision refused: an agent's note runs to thousands of characters, and a decision no schema
 * takes is one nobody can decide. Lists past their bound keep their first entries.
 */
export function fitProposal(p: DecisionProposal): DecisionProposal {
	return {
		verb: cutAtWord(p.verb, LIMITS.verb),
		what: cutAtWord(p.what, LIMITS.what),
		recommends: p.recommends,
		tags: p.tags
			.slice(0, LIMITS.tags)
			.map((t) => ({ ...t, text: cutAtWord(t.text, LIMITS.tag) })),
		consequences: p.consequences
			.slice(0, LIMITS.lines)
			.map((c) => cutAtWord(c, LIMITS.line)),
		why: p.why.slice(0, LIMITS.lines).map((w) => ({
			label: cutAtWord(w.label, LIMITS.label),
			value: cutKeepingLines(w.value, LIMITS.value),
		})),
		said: p.said === null ? null : cutKeepingLines(p.said, LIMITS.said),
		table: p.table && {
			title: cutAtWord(p.table.title, LIMITS.label),
			columns: p.table.columns.map((c) => cutAtWord(c, LIMITS.label)),
			rows: p.table.rows
				.slice(0, LIMITS.rows)
				.map((r) => r.map((cell) => cutKeepingLines(cell, LIMITS.cell))),
		},
		yields: p.yields,
	};
}
