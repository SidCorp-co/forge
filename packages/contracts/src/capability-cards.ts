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
});
export type CardSituation = z.infer<typeof cardSituationSchema>;

/**
 * What a door's card says beside the door itself. Its id and owner are the door's (the catalog
 * names them), so a card cannot drift from the door it sits next to.
 */
export const capabilityCardSchema = z.strictObject({
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
	 * When the card's text last changed and the landing that changed it (`ISS-n`), written with the
	 * change; the capabilities page reads a card's age from it.
	 */
	changed: z
		.strictObject({
			on: z.iso.date(),
			by: z.string().regex(/^ISS-\d+$/, "the issue that landed the change, ISS-n"),
		})
		.optional(),
	/** The replayable cases that prove an agent uses it right, by name; empty until one is written. */
	scenarios: z.array(z.string().trim().min(1).max(120)).default([]),
});
export type CapabilityCardBody = z.input<typeof capabilityCardSchema>;
export type CapabilityCardFields = z.output<typeof capabilityCardSchema>;

/** A card as served: its door, the feature that owns it, and what it says. */
export interface CapabilityCard extends CapabilityCardFields {
	/** The door: `support.member`, `POST /api/projects/:id/feedback`. */
	id: string;
	owner: string;
}
