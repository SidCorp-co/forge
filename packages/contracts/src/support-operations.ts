// A Rocket.Chat operations room (REQ-75 r4 BC-20..BC-24): a room a bot account answers under its
// role, reading every project of the room's scope and acting, where it acts, as the member who
// asked. Both halves are policy (VISION kernel-hard-policy-soft): the role on the bot's
// `rocketchat` connection (who the bot is, what it may do), the scope on the binding that attaches
// the room. What a role may never be granted, and whose permissions a write runs under, is the
// kernel: an act outside the role's grant, outside the room's scope, or for a member Forge cannot
// name is refused by name.

import { z } from "zod";
import { ISSUE_STATUSES } from "./issue-machine.js";
import { REASON_PARAGRAPH_MAX } from "./reason-text.js";
import { SUPPORT_RECORD_KINDS } from "./support.js";

/**
 * What a role may be granted. `read` the projects, issues, runners, masters and releases of the
 * room's scope; `deliver` move an issue, as the member who asked; `draft` draft a requirement or a
 * feedback item a person then decides; `research` read one public web page.
 */
export const OPERATIONS_GRANTS = [
	"read",
	"deliver",
	"draft",
	"research",
] as const;
export type OperationsGrant = (typeof OPERATIONS_GRANTS)[number];

/** Each grant in the words a refusal and the brief use. */
export const OPERATIONS_GRANT_MEANING: Record<OperationsGrant, string> = {
	read: "read the projects, issues, runners, masters and releases of this room's scope",
	deliver:
		"move delivery: change an issue's status, with the asking member's own permissions",
	draft:
		"draft product direction: a requirement or a feedback item that a person then decides",
	research: "read one public web page",
};

/**
 * A bot account's role (BC-22): its name, the persona its sessions are briefed with, and what it is
 * granted. It lives on the bot's `rocketchat` connection, one role per account.
 */
export const chatRoleSchema = z.strictObject({
	name: z
		.string()
		.regex(
			/^[a-z][a-z0-9-]{1,31}$/,
			"a role name: lower case letters, digits and -",
		),
	/** Who the bot is and what it does and never does, in its own words: the brief's first lines. */
	persona: z.string().trim().min(20).max(4000),
	grants: z
		.array(z.enum(OPERATIONS_GRANTS))
		.min(1)
		.max(OPERATIONS_GRANTS.length)
		.refine(
			(g) => new Set(g).size === g.length,
			"a grant is named once",
		),
});
export type ChatRole = z.infer<typeof chatRoleSchema>;

/** `forge`: every project of the home project's organization. `project`: the home project alone. */
export const OPERATIONS_SCOPES = ["forge", "project"] as const;
export type OperationsScope = (typeof OPERATIONS_SCOPES)[number];

/**
 * The `operations` block of a `rocketchat` binding: each room it names is an operations room with a
 * session of its own, answered by the connection's bot under its role.
 */
export const operationsRoomConfigSchema = z.strictObject({
	scope: z.enum(OPERATIONS_SCOPES),
});
export type OperationsRoomConfig = z.infer<typeof operationsRoomConfigSchema>;

/** A room answered for a product's users (`support`), or for the team under a role (`operations`). */
export const SUPPORT_ROOM_KINDS = ["support", "operations"] as const;
export type SupportRoomKind = (typeof SUPPORT_ROOM_KINDS)[number];

export const OPERATIONS_ACTIONS = [
	"projects",
	"issues",
	"releases",
	"move",
	"draft_requirement",
	"draft_feedback",
	"research",
] as const;
export type OperationsAction = (typeof OPERATIONS_ACTIONS)[number];

/** The grant each action needs. */
export const OPERATIONS_ACTION_GRANT: Record<OperationsAction, OperationsGrant> =
	{
		projects: "read",
		issues: "read",
		releases: "read",
		move: "deliver",
		draft_requirement: "draft",
		draft_feedback: "draft",
		research: "research",
	};

const threadId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
	.describe(
		"the thread: the id the message you answer carries as `thread` in what you were handed",
	);
const projectRef = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.describe("a project of this room's scope, by slug");
const issueKey = z
	.string()
	.trim()
	.regex(/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/, "an issue key, PREFIX-n")
	.describe("an issue key as `projects` and `issues` show it, e.g. ISS-12");

export const operationsProjectsRequestSchema = z.strictObject({});
export const operationsIssuesRequestSchema = z.strictObject({
	project: projectRef,
	status: z.enum(ISSUE_STATUSES).optional(),
	key: issueKey.optional(),
});
export const operationsReleasesRequestSchema = z.strictObject({
	project: projectRef,
});
export const operationsMoveRequestSchema = z.strictObject({
	thread: threadId,
	issue: issueKey,
	/** Named only where two projects of the scope share the key's prefix. */
	project: projectRef.optional(),
	to: z.enum(ISSUE_STATUSES),
	reason: z.string().trim().min(1).max(REASON_PARAGRAPH_MAX).optional(),
});
export const operationsDraftRequirementRequestSchema = z.strictObject({
	thread: threadId,
	project: projectRef,
	title: z.string().trim().min(3).max(200),
	summary: z.string().trim().min(3).max(4000),
});
export const operationsDraftFeedbackRequestSchema = z.strictObject({
	thread: threadId,
	project: projectRef,
	kind: z.enum(SUPPORT_RECORD_KINDS),
	title: z.string().trim().min(3).max(200),
	summary: z.string().trim().min(3).max(4000),
	/** What the item is about: exactly one of a requirement key, an issue key, or a screen in words. */
	requirement: z.string().trim().min(1).max(40).optional(),
	issue: issueKey.optional(),
	screen: z.string().trim().min(1).max(300).optional(),
});
export const operationsResearchRequestSchema = z.strictObject({
	thread: threadId,
	url: z
		.url()
		.max(2000)
		.regex(/^https:\/\//, "an https URL"),
});

/** How much of a page `research` hands back, as text. */
export const OPERATIONS_RESEARCH_MAX_CHARS = 12_000;
