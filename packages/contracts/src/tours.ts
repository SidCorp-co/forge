// The product tours' catalog: each tour's id and its revision. The changelog entry that introduced a
// tour names it with a `tour: <id>` line in its fragment. The steps, their anchors and the route each
// tour runs on are the web's (`packages/web-v2/src/features/tours/registry.ts`); the revision lives
// here so core can name it on a What's new entry and a person's stored outcome is read against the
// same number.

import { z } from "zod";

export const PRODUCT_TOURS = [
	{ id: "release-what-changes", revision: 1 },
	{ id: "integrations", revision: 1 },
] as const satisfies ReadonlyArray<{ id: string; revision: number }>;

export type TourId = (typeof PRODUCT_TOURS)[number]["id"];
export const TOUR_IDS = PRODUCT_TOURS.map((t) => t.id) as [TourId, ...TourId[]];

export const TOUR_STEPS_MAX = 4;

/** What a tour run records: it started, it was finished, it was closed at a step, or a step's anchor was missing. */
export const TOUR_EVENT_KINDS = ["started", "completed", "dismissed", "step_skipped"] as const;
export type TourEventKind = (typeof TOUR_EVENT_KINDS)[number];

export const tourEventRequestSchema = z
	.strictObject({
		tourId: z.enum(TOUR_IDS, {
			error: (issue) =>
				`tourId ${JSON.stringify(issue.input)} is not a tour: it is one of ${TOUR_IDS.join(", ")}`,
		}),
		revision: z.number().int().positive(),
		kind: z.enum(TOUR_EVENT_KINDS),
		step: z.number().int().min(1).max(TOUR_STEPS_MAX).optional(),
	})
	.refine((e) => (e.kind === "dismissed" || e.kind === "step_skipped") === (e.step !== undefined), {
		error: "step names the step a dismissed or step_skipped event happened at, and only those carry one",
		path: ["step"],
	});
export type TourEventRequest = z.infer<typeof tourEventRequestSchema>;
export const TOUR_EVENT_SHAPE = `{ tourId: ${TOUR_IDS.join(" | ")}, revision: positive integer, kind: ${TOUR_EVENT_KINDS.join(" | ")}, step?: 1-${TOUR_STEPS_MAX} (dismissed and step_skipped only) }`;
