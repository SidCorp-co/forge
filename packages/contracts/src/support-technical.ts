// A project's one technical channel and what a room agent may not do on its own (ISS-1243, owner
// 2026-11-15). Every permission or approval a room agent needs, every technical finding and every
// ask of the owner goes to the project's technical channel and nowhere else, so its work threads get
// only the answer; and the acts with serious consequence the project keeps from its room agents are
// a short deny list, each refused by name and raised in that channel.

import { z } from "zod";
import { chatUserIdSchema, supportThreadIdSchema } from "./support.js";

/**
 * Where a project's technical channel is (item 13): `thread` is the project's own thread of the
 * operations room its organization shares (at SidCorp, Forge-Communicate), opened on its first need
 * and recorded on that room's binding; `dm` is a direct message to one person, the chat server's
 * user id, the owner the room's binding names when `user` is omitted. One object: a project names
 * exactly one. Absent, it is the shared room's thread where the organization binds such a room, and
 * a direct message to the owner where it binds none (ISS-1271).
 */
export const technicalChannelSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("thread") }),
	z.strictObject({
		kind: z.literal("dm"),
		user: chatUserIdSchema.optional(),
	}),
]);
export type TechnicalChannel = z.infer<typeof technicalChannelSchema>;

/**
 * The morning reminder of what waits on a person (ISS-1343, owner 2026-11-19): each morning one
 * post in the project's technical channel lists every wait of the project open at least 12 hours,
 * until each is answered, voided or moved. `on` turns it off; `hour` (0-23) and `timeZone` (IANA)
 * set when it is posted. Absent, it is on at 08:00 Asia/Ho_Chi_Minh.
 */
export const waitReminderSchema = z.strictObject({
	on: z.boolean().optional(),
	hour: z.int().min(0).max(23).optional(),
	timeZone: z
		.string()
		.min(1)
		.max(64)
		.refine(
			(zone) => {
				try {
					new Intl.DateTimeFormat("en", { timeZone: zone });
					return true;
				} catch {
					return false;
				}
			},
			{ message: "an IANA time zone, such as Asia/Ho_Chi_Minh" },
		)
		.optional(),
});
export type WaitReminder = z.infer<typeof waitReminderSchema>;

/** The reminder where the project document names none, or leaves a part out. */
export const WAIT_REMINDER_DEFAULTS = {
	on: true,
	hour: 8,
	timeZone: "Asia/Ho_Chi_Minh",
} as const;

/** A wait younger than this many hours waits for the next morning's reminder. */
export const WAIT_REMINDER_MIN_AGE_HOURS = 12;

/** What a room agent raises in the technical channel. */
export const TECHNICAL_NEEDS = [
	"permission",
	"approval",
	"finding",
	"ask",
] as const;
export type TechnicalNeed = (typeof TECHNICAL_NEEDS)[number];

/**
 * The latest message a person wrote in the technical thread that a raise answers (ISS-1299): a raise
 * into a thread where someone spoke within the turn is held until it names that message, so its words
 * answer what he said rather than ask him again.
 */
export const technicalAnswersSchema = supportThreadIdSchema.describe(
	"the message id a held raise named (his latest in the technical thread): pass it once you read it, and your words answer him rather than ask him again",
);

/** support.technical: one need, raised from the thread it arose in, posted only in the technical channel. */
export const supportTechnicalRequestSchema = z.strictObject({
	thread: supportThreadIdSchema,
	need: z
		.enum(TECHNICAL_NEEDS)
		.describe(
			"what it is: a permission or an approval you need, a technical finding, or an ask of the owner",
		),
	text: z
		.string()
		.trim()
		.min(3)
		.max(2000)
		.describe(
			"your words to the person who reads the channel, in its language, to them in the second person",
		),
	answers: technicalAnswersSchema.optional(),
});
export type SupportTechnicalRequest = z.infer<
	typeof supportTechnicalRequestSchema
>;

/**
 * A project master's twin of support.technical (ISS-1405): the same need, raised in its project's
 * technical channel under the master's own credential, which the room session's door refuses. No
 * thread: a master raises from no work thread.
 */
export const supportMasterTechnicalRequestSchema =
	supportTechnicalRequestSchema.omit({ thread: true });
export type SupportMasterTechnicalRequest = z.infer<
	typeof supportMasterTechnicalRequestSchema
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
