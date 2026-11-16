// A room agent's way to a project's reference sources (ISS-1252, owner 2026-11-16: "he adds a source
// in plain words to the agent he talks to, and that agent records it; bots consult sources first").
// Each act is the references module's own request (`references.ts`) with what a room act names
// beside it: the project, by slug, of the room's reach; and for an add, the message that asked for
// it, whose writer the add runs as.

import { z } from "zod";
import {
	referenceAddRequestSchema,
	referenceCiteRequestSchema,
	referenceProposeRequestSchema,
	referenceSearchQuerySchema,
} from "./references.js";
import { supportProjectSlugSchema, supportThreadIdSchema } from "./support.js";

const project = supportProjectSlugSchema.optional();

/** `references`: a project's active sources, every one or those an area or words name. */
export const supportReferencesRequestSchema = referenceSearchQuerySchema.extend(
	{ project },
);

/**
 * `reference_add`: the source a person told you to follow, added as that person, under their own
 * Forge permissions on the project: their plain words are the add.
 */
export const supportReferenceAddRequestSchema =
	referenceAddRequestSchema.extend({
		thread: supportThreadIdSchema,
		message: supportThreadIdSchema.describe(
			"the person's message asking to follow the source, as you were handed it (`message`): the add is theirs",
		),
		project,
	});

/** `reference_cite`: one use of a source, recorded as the room agent's. */
export const supportReferenceCiteRequestSchema =
	referenceCiteRequestSchema.extend({
		source: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.describe("the source, by id, address or name (`owner/name`)"),
		project,
	});

/** `reference_propose`: a source the room agent kept using, recorded as its proposal. */
export const supportReferenceProposeRequestSchema =
	referenceProposeRequestSchema.extend({ project });
