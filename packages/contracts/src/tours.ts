// The product tours' catalog: each tour's id, its revision, and the issues on the platform project
// whose What's new entry opens it. The steps, their anchors and the route each tour runs on are the
// web's (`packages/web-v2/src/features/tours/registry.ts`); the revision lives here so core can name
// it on a What's new entry and a person's stored outcome is read against the same number.

import { z } from "zod";
import type { WhatsNewTourRef } from "./whats-new.js";

export const PRODUCT_TOURS = [
	{ id: "release-what-changes", revision: 1, issues: ["ISS-319"] },
	{ id: "integrations", revision: 1, issues: ["ISS-317"] },
] as const satisfies ReadonlyArray<{ id: string; revision: number; issues: readonly string[] }>;

export type TourId = (typeof PRODUCT_TOURS)[number]["id"];
const TOUR_IDS = PRODUCT_TOURS.map((t) => t.id) as [TourId, ...TourId[]];

export const TOUR_STEPS_MAX = 4;

/** The tour a platform issue's What's new entry opens, or null. */
export function tourOfIssue(key: string): WhatsNewTourRef | null {
	const tour = PRODUCT_TOURS.find((t) => (t.issues as readonly string[]).includes(key));
	return tour ? { id: tour.id, revision: tour.revision } : null;
}

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
