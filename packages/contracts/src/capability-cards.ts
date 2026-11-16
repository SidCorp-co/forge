// The capability card (ISS-1251): one source per agent-facing door, kept in the code next to the door
// it describes, from which every surface that teaches the door is rendered (the MCP action guide, the
// orientation row, the guide page, the room brief line). An agent reaches for a door from the
// situation it is in, never from the door's name, so a card leads with its situations.

import { z } from "zod";

/** Who a card teaches: a room's agent, a project's master, a run it starts, or a person's client. */
export const CARD_AUDIENCES = ["bot", "master", "run", "person"] as const;
export type CardAudience = (typeof CARD_AUDIENCES)[number];

/** The most characters the Tier-0 map of one audience takes: a line per situation, "when X → door". */
export const TIER0_MAP_MAX_CHARS = 2500;

export const CARD_LIMITS = {
	purpose: 160,
	situation: 600,
	practice: 300,
	redFlag: 400,
	practiceLines: 3,
	situations: 6,
} as const;

const line = (max: number) =>
	z
		.string()
		.trim()
		.min(3)
		.max(max)
		.regex(/^[^\n]+$/, "one line");

/** "when you are … → do …": the trigger an agent recognises in its own situation. */
export const cardSituationSchema = z.strictObject({
	when: line(CARD_LIMITS.situation),
	do: line(CARD_LIMITS.situation),
	/** What goes wrong in this situation, where it differs from the card's red flag. */
	watch: line(CARD_LIMITS.redFlag).optional(),
	/**
	 * The audiences this situation is met by, where only some of the card's are: a master meets an
	 * act over REST and a person over MCP, so one act's card says both. Absent, every audience.
	 */
	for: z.array(z.enum(CARD_AUDIENCES)).min(1).optional(),
});
export type CardSituation = z.infer<typeof cardSituationSchema>;

/**
 * What a door's card says beside the door itself. Its id and owner are the door's (the catalog
 * names them), so a card cannot drift from the door it sits next to.
 */
export const capabilityCardSchema = z
	.strictObject({
		purpose: line(CARD_LIMITS.purpose),
		situations: z.array(cardSituationSchema).min(1).max(CARD_LIMITS.situations),
		/** How to use it well, 1 to 3 lines. */
		practice: z
			.array(line(CARD_LIMITS.practice))
			.min(1)
			.max(CARD_LIMITS.practiceLines),
		/** One worked call, valid against the door's input (checked when the registry is built). */
		example: z.record(z.string(), z.unknown()).optional(),
		/** The wrong way agents actually take; absent until one is seen. */
		redFlag: line(CARD_LIMITS.redFlag).optional(),
		audience: z.array(z.enum(CARD_AUDIENCES)).min(1),
		/**
		 * Never written on the card: when its text last changed is read from the card ledger, which
		 * `cards:stamp` writes from the card itself (`packages/core/src/lib/card-changed.ts`).
		 */
		changed: z
			.never({
				error:
					"a card's changed is derived, never written: drop it and run `pnpm --filter @forge/core cards:stamp`",
			})
			.optional(),
		/** The replayable cases that prove an agent uses it right, by name; empty until one is written. */
		scenarios: z.array(z.string().trim().min(1).max(120)).default([]),
	})
	.superRefine((card, ctx) => {
		for (const [i, s] of card.situations.entries()) {
			for (const a of s.for ?? []) {
				if (!card.audience.includes(a)) {
					ctx.addIssue({
						code: "custom",
						path: ["situations", i, "for"],
						message: `${a} is not among the card's audience (${card.audience.join(", ")})`,
					});
				}
			}
		}
	});
export type CapabilityCardBody = z.input<typeof capabilityCardSchema>;
export type CapabilityCardFields = z.output<typeof capabilityCardSchema>;

/** A card as served: its door, the feature that owns it, and what it says. */
/** When a card's text last changed and the issue whose landing changed it, as its ledger holds. */
export interface CardChanged {
	on: string;
	by: string;
}

export interface CapabilityCard extends Omit<CapabilityCardFields, "changed"> {
	/** The door: `support.member`, `POST /api/projects/:id/feedback`. */
	id: string;
	owner: string;
	/**
	 * From the card ledger, present only while the ledger's hash is this text's: a card edited and not
	 * stamped reads no date rather than an old one.
	 */
	changed?: CardChanged;
}

/** The situations of a card one audience meets. */
export const situationsFor = (
	card: Pick<CapabilityCardFields, "situations">,
	audience: CardAudience,
): CardSituation[] =>
	card.situations.filter((s) => !s.for || s.for.includes(audience));
