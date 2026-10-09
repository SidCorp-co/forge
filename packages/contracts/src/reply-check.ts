// What a reply the reply check held still shows (REQ-41 BC-3; Chat turn `check` and `held`): the part
// it could check, never nothing. A held Assistant-mode reply goes out as the clauses the check passed,
// the blocks the turn's own reads drew, and one notice naming what was left out and why. Core writes
// it (`messaging/reply-screen.ts`, `conversations/fallback-replies.ts`); the thread renders it.

import { z } from "zod";

/** What a held clause claimed that nothing the turn read backs. */
export const HELD_CLAIMS = [
	"figure",
	"date",
	"issue",
	"status",
	"record",
] as const;
export type HeldClaimKind = (typeof HELD_CLAIMS)[number];

/**
 * How a reply left the check: `checked` whole, `partial` with its unchecked clauses left out (BC-3),
 * `withheld` where no clause and no block could be shown, which then reads as a notice alone.
 */
export const REPLY_VERDICTS = ["checked", "partial", "withheld"] as const;
export type ReplyVerdict = (typeof REPLY_VERDICTS)[number];

const HELD_WORDS: Record<HeldClaimKind, [one: string, many: string]> = {
	figure: ["a figure", "figures"],
	date: ["a date", "dates"],
	issue: ["an issue key", "issue keys"],
	status: ["a claim about where work stands", "claims about where work stands"],
	record: [
		"a claim to have saved or shared something",
		"claims to have saved or shared something",
	],
};

/** One kind of claim left out, and how many clauses made it. */
export const heldClaimCountSchema = z.strictObject({
	claim: z.enum(HELD_CLAIMS),
	count: z.int().min(1),
});
export type HeldClaimCount = z.infer<typeof heldClaimCountSchema>;

/**
 * A partial reply: what was shown and what was left out. `shown` is the draft with each held clause
 * cut whole (never a clause blanked mid-sentence); `blocks` counts the tables and charts the turn's
 * reads drew, shown beside it because they are drawn from those reads and nothing else. At least one
 * of the two is non-empty, or the verdict is `withheld`.
 */
export const heldPartSchema = z
	.strictObject({
		verdict: z.literal("partial"),
		shown: z.string(),
		blocks: z.int().min(0),
		held: z.array(heldClaimCountSchema).min(1),
	})
	.refine((p) => p.shown.trim() !== "" || p.blocks > 0, {
		message:
			"a partial reply shows checked text or a block its reads drew; with neither it is withheld",
		path: ["shown"],
	})
	.refine((p) => new Set(p.held.map((h) => h.claim)).size === p.held.length, {
		message: "each claim kind is counted once",
		path: ["held"],
	});
export type HeldPart = z.infer<typeof heldPartSchema>;

/** The one line under a partial reply, in Forge's English: what was left out, and that the rest was checked. */
export function heldPartNotice(held: readonly HeldClaimCount[]): string {
	const parts = held.map(({ claim, count }) => {
		const [one, many] = HELD_WORDS[claim];
		return count === 1 ? one : `${count} ${many}`;
	});
	const listed =
		parts.length > 1
			? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
			: parts[0];
	return `The reply check left out ${listed} that nothing this answer read backs. What is shown above was checked.`;
}
