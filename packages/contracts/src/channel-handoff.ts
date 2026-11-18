// A finding handed to another project's intake through the ecosystem channel (ISS-1286, REQ-102):
// a master that finds a defect in another project's part files it there as that project's feedback,
// naming where it came from, and the item it came from records the key it was filed under.

import { z } from "zod";
import {
	FEEDBACK_KINDS,
	FEEDBACK_LIMITS,
	FEEDBACK_SEVERITIES,
} from "./feedback.js";
import { titleText } from "./title-text.js";

/** `POST /api/projects/:id/channel/handoffs`, where `:id` is the project the finding is handed from. */
export const channelHandoffRequestSchema = z.strictObject({
	/** The project whose intake takes it, by uuid. */
	to: z.uuid(),
	/** The item of this project it is handed from: an issue (`ISS-12` or its uuid) or a feedback item (`FB-4`). */
	item: z.string().trim().min(1).max(80),
	kind: z.enum(FEEDBACK_KINDS),
	severity: z.enum(FEEDBACK_SEVERITIES).optional(),
	title: titleText(FEEDBACK_LIMITS.title),
	body: z.string().max(FEEDBACK_LIMITS.body).optional(),
	/** Where in the receiving project's product it shows: a screen, a route, a command. */
	whereSeen: z.string().trim().min(1).max(FEEDBACK_LIMITS.whereSeen),
});
export type ChannelHandoffRequest = z.infer<typeof channelHandoffRequestSchema>;

export const CHANNEL_HANDOFF_SHAPE = `{ to: <the receiving project's uuid>, item: <ISS-n or FB-n of this project>, kind: ${FEEDBACK_KINDS.join(" | ")}, title, whereSeen, body?, severity?: ${FEEDBACK_SEVERITIES.join(" | ")} }`;

/** What a handoff answers: where it went, under which key, and whether this call filed it. */
export interface ChannelHandoffView {
	ecosystem: { id: string; slug: string };
	from: { project: { id: string; slug: string }; item: string };
	to: {
		project: { id: string; slug: string };
		feedback: { id: string; key: string };
	};
	/** False where the item was already handed there and that feedback is still open: nothing was written. */
	created: boolean;
}
