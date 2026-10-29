// A bound Rocket.Chat group's channel record (REQ-75 r6 BC-30..BC-41): who is in it and what each
// one is asked for, the rules its people gave, the questions it keeps asking, and where each kind of
// need goes. It lives in Forge, keyed by the project and the group, and every bot session bound to
// that group reads the same record (BC-41). The session writes what it inferred; a person's
// correction confirms it, and the bot never writes over that (BC-33).

import { z } from "zod";
import { REASON_NOTE_MAX } from "./reason-text.js";
import {
	chatUsernameSchema,
	supportRoomConfigSchema,
	supportThreadIdSchema,
} from "./support.js";
import { operationsRoomConfigSchema } from "./support-operations.js";

/** What a member does in the channel (BC-31); a member carries one or more. */
export const CHANNEL_ROLES = [
	"user",
	"product",
	"technical",
	"maintenance",
	"bot",
] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

export const CHANNEL_ROLE_LABEL: Record<ChannelRole, string> = {
	user: "User",
	product: "Product",
	technical: "Technical",
	maintenance: "Maintenance",
	bot: "Bot",
};

/** The roles whose instructions become channel rules (BC-35): the team, never a product user. */
export const CHANNEL_RULE_ROLES: readonly ChannelRole[] = [
	"product",
	"technical",
	"maintenance",
];

/** The roles a reply may carry developer detail to (BC-37); every other asker reads plain words. */
export const CHANNEL_DETAIL_ROLES: readonly ChannelRole[] = [
	"technical",
	"maintenance",
	"bot",
];

/**
 * The roles that allow a change to a running system (REQ-77 BC-10): a channel agent's fix, build,
 * deploy or command in a group is confirmed by a named confirmer, the owner under owner mode, or a
 * member a person confirmed in the channel record as one of these. A User, a Product member, a Bot
 * or a role the bot only inferred confirms nothing.
 */
export const CHANGE_CONFIRM_ROLES: readonly ChannelRole[] = [
	"technical",
	"maintenance",
];

/** inferred: the bot read it from messages (BC-32). confirmed: a person set it (BC-33). */
export const CHANNEL_MEMBER_STATES = ["inferred", "confirmed"] as const;
export type ChannelMemberState = (typeof CHANNEL_MEMBER_STATES)[number];

/**
 * Where a need goes, never mixed (BC-38): a problem with Forge itself to the Forge master as Forge
 * feedback; an act only a technical person can do to a Technical member; a business rule or a
 * user's need to a Product member. The last two are asked in the asker's thread.
 */
export const CHANNEL_ROUTES = ["forge", "technical", "product"] as const;
export type ChannelRoute = (typeof CHANNEL_ROUTES)[number];

/** How many threads a question is asked in before it is a common issue (BC-36). */
export const SUPPORT_COMMON_ISSUE_MIN_THREADS = 2;
/** At most one top-level announcement per channel in this window (BC-39). */
export const SUPPORT_ANNOUNCE_EVERY_MS = 60 * 60_000;

/**
 * A Rocket.Chat binding's `outsideRids`: the groups an agent outside Forge answers. Forge keeps each
 * one's channel record, which that agent reads, and answers nothing there itself: no room, no
 * session, no reply. A group is in `rids` (answered by Forge) or here, never both.
 */
export const outsideRidsSchema = z
	.array(z.string().min(1).max(200))
	.min(1)
	.max(20)
	.refine((rids) => new Set(rids).size === rids.length, {
		message: "a group is named once",
	});

/**
 * The groups a `rocketchat` binding names and who answers them: a support group (one room, REQ-75),
 * operations rooms (BC-20), or the project's channel agent (REQ-77), at most one of the three and
 * each refused by name otherwise (core's `integrations/rocketchat/support-binding.ts`); and the
 * groups an agent outside Forge answers, whose channel record only Forge keeps (REQ-75 r6). The
 * project document and the connection's binding both validate it.
 */
export const rocketchatBindingTargetShape = {
	rids: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
	support: supportRoomConfigSchema.optional(),
	operations: operationsRoomConfigSchema.optional(),
	agent: supportRoomConfigSchema.optional(),
	outsideRids: outsideRidsSchema.optional(),
};

export const channelRolesSchema = z
	.array(z.enum(CHANNEL_ROLES))
	.min(1)
	.max(CHANNEL_ROLES.length)
	.refine((r) => new Set(r).size === r.length, "a role is named once");

/** What to ask a member for, in a few words: `DNS via the domain manager`. */
export const channelAskForSchema = z.string().trim().min(2).max(300);
export const channelRuleTextSchema = z.string().trim().min(3).max(600);
const feedbackKeySchema = z
	.string()
	.regex(/^FB-\d{1,9}$/, "a feedback key of this project, such as FB-12");

/** The session's inference about one member (BC-32), read from the message it names. */
export const supportMemberRequestSchema = z.strictObject({
	member: chatUsernameSchema,
	roles: channelRolesSchema,
	askFor: channelAskForSchema.optional(),
	/** The message the inference was read from. */
	message: supportThreadIdSchema,
});

/** An instruction a member gave in the channel, kept as a rule linked to its message (BC-35). */
export const supportRuleRequestSchema = z.strictObject({
	thread: supportThreadIdSchema,
	message: supportThreadIdSchema,
	text: channelRuleTextSchema,
});

/** A question asked again, with its one answer (BC-36). */
export const supportCommonIssueRequestSchema = z.strictObject({
	/** The threads it was asked in; a new common issue names at least two. */
	threads: z.array(supportThreadIdSchema).min(1).max(20),
	question: z.string().trim().min(3).max(300),
	answer: z.string().trim().min(3).max(2000),
	/** The Feedback item a defect was recorded as. */
	feedback: feedbackKeySchema.optional(),
});

/** One need sent where it belongs (BC-38): its fields, before the rule tying them to the route. */
export const supportRouteFieldsSchema = z.strictObject({
	thread: supportThreadIdSchema,
	to: z.enum(CHANNEL_ROUTES),
	/** Technical or product: the one member asked, holding that role. */
	member: chatUsernameSchema.optional(),
	/** Forge: the report's title. */
	title: z.string().trim().min(3).max(200).optional(),
	text: z.string().trim().min(3).max(2000),
});

/** One need sent where it belongs (BC-38). */
export const supportRouteRequestSchema = supportRouteFieldsSchema.superRefine(
	(r, ctx) => {
		if (r.to === "forge") {
			if (!r.title) {
				ctx.addIssue({
					code: "custom",
					path: ["title"],
					message: "a Forge report needs a title",
				});
			}
			if (r.member) {
				ctx.addIssue({
					code: "custom",
					path: ["member"],
					message:
						"a Forge report goes to the Forge master, never to a member of the channel",
				});
			}
		} else if (!r.member) {
			ctx.addIssue({
				code: "custom",
				path: ["member"],
				message: `a ${r.to} route names the one member asked, by username`,
			});
		}
	},
);

/** The one top-level post: news that changes something for everyone in the channel (BC-39). */
export const supportAnnounceRequestSchema = z.strictObject({
	text: z.string().trim().min(3).max(1000),
});

/**
 * A question to the owner through the channel (REQ-77 BC-12). It is posted in the thread it names;
 * the owner's next message there, by the id the chat server signed, is the answer: it reaches the
 * asking session, and the issue `record` names, where one is named, as a note.
 */
export const supportAskOwnerRequestSchema = z.strictObject({
	thread: supportThreadIdSchema,
	question: z.string().trim().min(3).max(1500),
	/** An issue of this project the answer is also written on, such as `ISS-12`. */
	record: z
		.string()
		.regex(
			/^ISS-\d{1,9}$/,
			"an issue key of this project, such as ISS-12: an answer is written on an issue only",
		)
		.optional(),
});

/** A person's correction of a member (BC-33): written confirmed. */
export const channelMemberWriteSchema = z.strictObject({
	roles: channelRolesSchema,
	askFor: channelAskForSchema.nullable().optional(),
});
export type ChannelMemberWrite = z.infer<typeof channelMemberWriteSchema>;

/** A rule a person adds on the channel's page. */
export const channelRuleWriteSchema = z.strictObject({
	text: channelRuleTextSchema,
});

export interface ChannelMemberView {
	username: string;
	roles: ChannelRole[];
	state: ChannelMemberState;
	askFor: string | null;
	/** Who confirmed it, by name; null while it is inferred. */
	confirmedBy: string | null;
	updatedAt: string;
}

export interface ChannelRuleView {
	id: string;
	text: string;
	/** The member whose message it came from; null for a rule a person added in Forge. */
	author: string | null;
	/** The message it is linked to; null for a rule a person added in Forge. */
	message: string | null;
	thread: string | null;
	createdAt: string;
}

export interface ChannelCommonIssueView {
	id: string;
	question: string;
	answer: string;
	/** How many threads it was asked in. */
	threads: number;
	feedbackKey: string | null;
	updatedAt: string;
}

export interface ChannelRouteView {
	route: ChannelRoute;
	/** The members it goes to; empty for Forge, which goes to the Forge master. */
	members: string[];
}

export interface ChannelSummaryView {
	rid: string;
	/** The group's name on the chat server, where a bot can read it. */
	name: string | null;
	members: number;
	rules: number;
	commonIssues: number;
}

/**
 * Where a Forge-placed session is reached now: its session id, which a restart replaces. An agent
 * outside Forge is reached at the address it declared itself (REQ-75 r7 BC-42..BC-44).
 */
export const FORGE_SESSION_ADDRESS_PREFIX = "forge-session:";
export const forgeSessionAddress = (sessionId: string): string =>
	`${FORGE_SESSION_ADDRESS_PREFIX}${sessionId}`;

/**
 * The role a project's channel agent is listed under (REQ-77 BC-14): the one session Forge placed
 * to answer every group its binding names under `agent`.
 */
export const CHANNEL_AGENT_ROLE = "channel agent";

/** The two kinds of agent session a project lists by role (BC-43). */
export const AGENT_ROLE_KINDS = ["master", "channel"] as const;
export type AgentRoleKind = (typeof AGENT_ROLE_KINDS)[number];

/** An agent session as a peer finds it (BC-43, BC-44): its role, its box, and where it is now. */
export interface AgentRoleView {
	kind: AgentRoleKind;
	/** `master`; a Forge channel bot's room kind (`support`, `operations`); an outside agent's own. */
	role: string;
	/** The group a channel agent answers; null for a master. */
	channel: string | null;
	answeredBy: "forge" | "outside";
	/** The box it runs on, by name. */
	box: string | null;
	/** Where it is reached now: `forge-session:<id>` for Forge's own, or what an outside agent declared. */
	address: string;
	/** The terminal it runs in on its box, where the box named one. */
	terminal: string | null;
	/** Since when this address is current. */
	since: string;
}

/** An agent outside Forge declaring itself on the group it answers (BC-42), again on each restart. */
export const channelAgentWriteSchema = z.strictObject({
	role: z.string().trim().min(2).max(80),
	box: z.string().trim().min(1).max(120),
	address: z.string().trim().min(1).max(300),
});
export type ChannelAgentWrite = z.infer<typeof channelAgentWriteSchema>;

export interface ChannelView extends ChannelSummaryView {
	/** The agent session answering the group now (BC-42); null when none is live or declared. */
	agent: AgentRoleView | null;
	memberRows: ChannelMemberView[];
	ruleRows: ChannelRuleView[];
	commonIssueRows: ChannelCommonIssueView[];
	routes: ChannelRouteView[];
}

/**
 * A channel agent's one result for one firing of a scheduled check (REQ-77 BC-13): `check` is the
 * firing's thread as it was handed (`check:<name>:<date>`); a finding is posted in the group, none
 * posts nothing.
 */
export const supportCheckResultRequestSchema = z.strictObject({
	check: z
		.string()
		.regex(
			/^check:[a-z0-9][a-z0-9-]{1,39}:\d{4}-\d{2}-\d{2}$/,
			"the check as it was handed: check:<name>:<YYYY-MM-DD>",
		),
	finding: z.string().trim().min(3).max(1500).nullable(),
});

/**
 * A git credential an owner-mode channel agent's git or `gh` asks for (ISS-765): the host and the
 * repository path git names, as its credential helper is sent them.
 */
export const supportGitCredentialRequestSchema = z.strictObject({
	host: z.string().trim().min(1).max(255),
	path: z.string().trim().min(1).max(500),
});

/** One duty an outside bot does in a group, which the Forge agent passes before the switch (BC-16). */
export const channelSwitchDutySchema = z.strictObject({
	/** A short key, `owner-mode`, by which a person marks it passed. */
	key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "a duty's key is 2 to 40 lowercase letters, digits and dashes"),
	text: z.string().trim().min(3).max(600),
});

/**
 * A group's switch from its outside bot to the project's channel agent (REQ-77 BC-16..BC-19): the
 * outside bot's chat account, which the switch removes from the group; the duties the agent passes
 * first; the switch it waits on (AdminHub after OrbitInternal, BC-18); and whether the owner's word
 * is needed (mail, BC-19).
 */
export const channelSwitchPlanSchema = z.strictObject({
	outsideBot: z.strictObject({
		/** The outside bot's account id on the chat server, as the server signs its messages. */
		userId: z.string().trim().min(1).max(200),
		username: z.string().trim().min(1).max(120).optional(),
	}),
	duties: z
		.array(channelSwitchDutySchema)
		.min(1)
		.max(40)
		.refine((d) => new Set(d.map((x) => x.key)).size === d.length, "a duty's key is named once"),
	/** Another channel's switch this one waits on until a person marks it proven. */
	after: z.uuid().optional(),
	/** The owner's word is needed before this group switches. */
	ownerWord: z.boolean().optional(),
});
export type ChannelSwitchPlan = z.infer<typeof channelSwitchPlanSchema>;

/** A person passing one duty, naming what they saw the agent do. */
export const channelSwitchPassSchema = z.strictObject({
	evidence: z.string().trim().min(3).max(1000),
});

/** The owner's word, as they gave it. */
export const channelSwitchOwnerWordSchema = z.strictObject({
	words: z.string().trim().min(2).max(600),
});

/** A person marking a switched group as answered as well as its outside bot answered it. */
export const channelSwitchProvenSchema = z.strictObject({
	note: z.string().trim().min(3).max(REASON_NOTE_MAX),
});

export interface ChannelSwitchDutyView {
	key: string;
	text: string;
	passedBy: string | null;
	passedAt: string | null;
	evidence: string | null;
}

/** What still stands between a group and its switch; empty once it may switch. */
export type ChannelSwitchOpen =
	| { kind: "duty"; key: string }
	| { kind: "after"; switchId: string; rid: string }
	| { kind: "owner_word" };

export interface ChannelSwitchView {
	id: string;
	projectId: string;
	rid: string;
	outsideBot: { userId: string; username: string | null };
	duties: ChannelSwitchDutyView[];
	after: string | null;
	ownerWordNeeded: boolean;
	ownerWord: { words: string; by: string; at: string } | null;
	open: ChannelSwitchOpen[];
	switchedAt: string | null;
	provenAt: string | null;
	provenNote: string | null;
}
