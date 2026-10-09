// The idea the chat assistant offers to build as a live preview (REQ-41 BC-14): the model names the
// requirement or feedback item and what the person asked for, core checks the item is the project's
// and the person may open a preview, and the browser draws a button. Nothing opens until the person
// presses it, and then it opens as them through `POST /api/projects/:id/previews`.

import { z } from "zod";
import { PREVIEW_IDEA_LIMITS } from "./preview.js";

/** The tool the model calls to offer one. */
export const IDEA_OFFER_TOOL = "offer_preview" as const;

export const IDEA_OFFER_REFUSAL_CODES = [
	"IDEA_OFFER_INVALID",
	"IDEA_OFFER_ITEM_UNKNOWN",
	"IDEA_OFFER_FORBIDDEN",
] as const;
export type IdeaOfferRefusalCode = (typeof IDEA_OFFER_REFUSAL_CODES)[number];

const ITEM_KEY = z
	.string()
	.regex(
		/^(REQ|FB)-\d{1,9}$/,
		"a requirement or feedback key such as REQ-41 or FB-12",
	);

export const ideaOfferParamsSchema = z.strictObject({
	about: ITEM_KEY,
	/** What the person asked to see, in their words; the sketch run is briefed with it. */
	brief: z.string().trim().min(1).max(PREVIEW_IDEA_LIMITS.brief),
});
export type IdeaOfferParams = z.infer<typeof ideaOfferParamsSchema>;

export const ideaOfferSchema = z.strictObject({
	v: z.literal(1),
	projectId: z.uuid(),
	about: ITEM_KEY,
	title: z.string(),
	brief: z.string(),
});
export type IdeaOffer = z.infer<typeof ideaOfferSchema>;

/** The offer a tool result carries, or null where the result is not one. */
export function readIdeaOffer(resultText: string): IdeaOffer | null {
	try {
		const body = JSON.parse(resultText) as { offer?: unknown };
		const parsed = ideaOfferSchema.safeParse(body.offer);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
