// What a person decides from (ISS-1006, owner 2026-11-05): the agent that raises a decision writes it
// in at most three plain lines in the reader's language: what changes for the user; why now (what
// waits on it); what it recommends, each choice named by its outcome and no ISS-/REQ-/BC- key carrying
// the meaning. It is stored beside the question or proposal, never derived from it, and a writer that
// sends none is never refused (owner, 2026-11-05: teach, do not block): the screens say plainly that
// the agent wrote no summary, so whether the teaching took is visible where the person decides.

import { z } from "zod";

/** The room three plain lines take, with slack for a language that writes long words. */
export const PLAIN_DECISION_MAX = 1000;

/** The teaching, said once: each writer's own field and prompt read this sentence. */
export const PLAIN_DECISION_RULE =
	"at most three plain lines in the project's content language, for the person who decides: what changes for the user; why now (what waits on it); what you recommend. Name each choice by its outcome; never let an ISS-, REQ- or BC- key carry the meaning";

export const plainDecisionSchema = z
	.string()
	.trim()
	.max(PLAIN_DECISION_MAX)
	.describe(`\`plain\`: ${PLAIN_DECISION_RULE}`);

/** The plain text as stored: trimmed, and absent where nothing was written. */
export function plainOf(text: string | null | undefined): string | null {
	const t = text?.trim();
	return t ? t : null;
}

/** The first line of a text that says something, trimmed; null where it says nothing. */
const firstLineOf = (text: string | null | undefined): string | null =>
	text
		?.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0) ?? null;

/**
 * The one line a pending decision is listed by, wherever it is listed (ISS-1006 round 2): the
 * asker's plain text, its first line, else the question's own first line, as every list read it
 * before plain text existed. A decision raised before its asker was taught, or by one that has not
 * learned yet, so reads no less than it did; `fromPlain` says which it is, for the screen's marker.
 */
export function decisionLineOf(d: {
	plain?: string | null | undefined;
	question: string;
}): { line: string; fromPlain: boolean } {
	const plain = firstLineOf(d.plain);
	if (plain) return { line: plain, fromPlain: true };
	return { line: firstLineOf(d.question) ?? d.question, fromPlain: false };
}
