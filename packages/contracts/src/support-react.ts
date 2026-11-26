// A room agent's reaction to a message of its own thread (ISS-1475; owner 2026-11-26: "no 'I am
// checking' message: acknowledge by a reaction on the asker's message"). Core already reacts with the
// received emoji when a message arrives; this is the agent's own act, for the acknowledgements it
// judges right. It posts no text.

import { z } from "zod";
import { supportThreadIdSchema } from "./support.js";

/** The reactions a room agent may set: seen, working on it, done, agreed. */
export const SUPPORT_REACT_EMOJIS = [
	"eyes",
	"hourglass_flowing_sand",
	"white_check_mark",
	"thumbsup",
] as const;

/** `react`: set one reaction on a message a member wrote in a thread of the agent's own group. */
export const supportReactRequestSchema = z.strictObject({
	thread: supportThreadIdSchema,
	message: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
		.describe(
			"the message to react to, as it carries `message` in what you were handed; it must be in `thread`",
		),
	emoji: z
		.enum(SUPPORT_REACT_EMOJIS)
		.describe(
			`one of ${SUPPORT_REACT_EMOJIS.join(" | ")}: no other reaction is taken`,
		),
});
export type SupportReactRequest = z.infer<typeof supportReactRequestSchema>;

export const SUPPORT_REACT_SHAPE = "{ thread, message, emoji }";
