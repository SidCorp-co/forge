// A room agent asks its project's master, or a followed project's, in its turn, and the answer comes
// back into the same session (ISS-1243 item 14); the ask wakes the master at once and is answered
// before its other work, and its wait is measured against a bound (item 21). One shared picture
// (item 20): the agent reads what the masters have in flight for its thread and asker, and a master
// reads the agent's open threads and the promises made in them.

import { z } from "zod";
import { supportProjectSlugSchema, supportThreadIdSchema } from "./support.js";
import { technicalAnswersSchema } from "./support-technical.js";

/**
 * How long a room agent's ask may wait for its master before it reads as a breach. The person is
 * waiting in the thread while the agent waits: the room answers a message in a median 0.9 minute,
 * and the owner asked for an answer "within minutes" (ISS-1243). A master whose session is free
 * (item 22) is woken at once and takes the ask first, so ten minutes holds one pass of a free master
 * and the tool call it was in, and nothing a pane busy building would still meet.
 */
export const SUPPORT_MASTER_ASK_BOUND_MINUTES = 10;

export const supportAskMasterRequestSchema = z.strictObject({
	thread: supportThreadIdSchema,
	question: z
		.string()
		.trim()
		.min(3)
		.max(2000)
		.describe(
			"what you need from the master to answer the person now, in plain words; one question",
		),
	project: supportProjectSlugSchema
		.optional()
		.describe(
			"the project whose master you ask, by slug, one you follow; your home project when omitted",
		),
});
export type SupportAskMasterRequest = z.infer<
	typeof supportAskMasterRequestSchema
>;

export const supportInFlightRequestSchema = z.strictObject({
	thread: supportThreadIdSchema,
});

/** A master's answer to a room agent's ask, handed into the asking session's thread. */
export const supportMasterAskAnswerRequestSchema = z.strictObject({
	answer: z.string().trim().min(1).max(4000),
});

export const supportMasterAsksQuerySchema = z.strictObject({
	state: z.enum(["open", "all"]).optional(),
});

/** The agent puts an item owed to the owner to him in the technical channel (ISS-1243 item 23). */
export const supportRaiseOwedRequestSchema = z.strictObject({
	thread: supportThreadIdSchema.describe(
		"the owed- task thread you were handed the item in",
	),
	text: z
		.string()
		.trim()
		.min(3)
		.max(2000)
		.describe(
			"the item in plain words, its options and your recommendation, as he reads it",
		),
	answers: technicalAnswersSchema.optional(),
});
