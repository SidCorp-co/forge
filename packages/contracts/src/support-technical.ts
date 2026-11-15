// A project's one technical channel and what a room agent may not do on its own (ISS-1243, owner
// 2026-11-15). Every permission or approval a room agent needs, every technical finding and every
// ask of the owner goes to the project's technical channel and nowhere else, so its work threads get
// only the answer; and the acts with serious consequence the project keeps from its room agents are
// a short deny list, each refused by name and raised in that channel.

import { z } from "zod";
import { chatUserIdSchema, supportThreadIdSchema } from "./support.js";

/**
 * Where a project's technical channel is (item 13): `thread` is the project's own thread of the
 * operations room its organization shares (Forge-Communicate), as that room's binding records it;
 * `dm` is a direct message to one person, the chat server's user id, the owner the room's binding
 * names when `user` is omitted. One object: a project names exactly one.
 */
export const technicalChannelSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("thread") }),
	z.strictObject({
		kind: z.literal("dm"),
		user: chatUserIdSchema.optional(),
	}),
]);
export type TechnicalChannel = z.infer<typeof technicalChannelSchema>;

/** What a room agent raises in the technical channel. */
export const TECHNICAL_NEEDS = [
	"permission",
	"approval",
	"finding",
	"ask",
] as const;
export type TechnicalNeed = (typeof TECHNICAL_NEEDS)[number];

/** support.technical: one need, raised from the thread it arose in, posted only in the technical channel. */
export const supportTechnicalRequestSchema = z.strictObject({
	thread: supportThreadIdSchema,
	need: z
		.enum(TECHNICAL_NEEDS)
		.describe(
			"what it is: a permission or an approval you need, a technical finding, or an ask of the owner",
		),
	text: z.string().trim().min(3).max(2000),
});
export type SupportTechnicalRequest = z.infer<
	typeof supportTechnicalRequestSchema
>;

/**
 * The acts with serious consequence a room agent may not run on its own (item 16): each is refused
 * by name and raised in the technical channel. The project document's `agentDeny` names them; absent
 * is every one of them, and an empty list denies none.
 */
export const AGENT_DENY_CLASSES = [
	"production_deploy",
	"data_deletion",
	"money_movement",
	"credential_change",
] as const;
export type AgentDenyClass = (typeof AGENT_DENY_CLASSES)[number];

export const agentDenySchema = z
	.array(z.enum(AGENT_DENY_CLASSES))
	.max(AGENT_DENY_CLASSES.length)
	.refine((d) => new Set(d).size === d.length, "an act is named once");
