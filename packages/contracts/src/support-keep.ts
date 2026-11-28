// A room agent keeps what it learns (ISS-1485, REQ-107 BC-5; owner ruling 2026-11-28: the agent keeps
// case summaries and agreed precedents, retrieved when relevant each turn). A summary is a project
// knowledge entry the agent writes as a fact, with where it applies and the case it came from, and
// core hands the relevant ones into a later turn; it never answers for the agent. A precedent is the
// owner's alone (`SUPPORT_PRECEDENT_PREFIX`, `rule.write`): a summary's slug is always `case-<topic>`,
// so the act cannot write one.

import { z } from "zod";
import {
	KNOWLEDGE_RECHECK_WHEN_MAX,
	KNOWLEDGE_SCOPE_MAX,
} from "./knowledge.js";
import { supportProjectSlugSchema, supportThreadIdSchema } from "./support.js";

/** The slug prefix of a kept summary: `case-<topic>`, a project knowledge entry (kind guide). */
export const SUPPORT_KEPT_PREFIX = "case-";

/** The most kept summaries a turn is handed, and the characters its note may hold in all. */
export const SUPPORT_KEPT_NOTE_MAX_ENTRIES = 3;
export const SUPPORT_KEPT_NOTE_MAX_CHARS = 3000;

/** What a summary is about: the project, a recurring technical problem, or a user. */
export const SUPPORT_KEEP_ABOUT = ["project", "problem", "user"] as const;

/** `keep`: one summary of what the agent learned, written as the room agent's own fact. */
export const supportKeepRequestSchema = z.strictObject({
	thread: supportThreadIdSchema.describe(
		"the case's thread: it is the summary's source",
	),
	project: supportProjectSlugSchema.optional(),
	topic: z
		.string()
		.trim()
		.min(1)
		.max(100)
		.regex(
			/^[a-z0-9][a-z0-9-]*$/,
			"a kebab-case topic, e.g. export-size-column",
		)
		.describe(
			"what it is about, kebab-case: kept as `case-<topic>`, and an existing one is rewritten",
		),
	concerns: z.enum(SUPPORT_KEEP_ABOUT),
	title: z.string().trim().min(1).max(200).describe("the summary in a line"),
	learned: z
		.string()
		.trim()
		.min(1)
		.max(1200)
		.describe(
			"what you learned and what settled it, as a fact: the problem, the cause, what fixed it or who decided; never a person's secret",
		),
	scope: z
		.string()
		.trim()
		.min(1)
		.max(KNOWLEDGE_SCOPE_MAX)
		.describe("where it applies: which sites, users or cases"),
	recheckWhen: z
		.string()
		.trim()
		.min(1)
		.max(KNOWLEDGE_RECHECK_WHEN_MAX)
		.describe("the change that means it needs checking again"),
});
export type SupportKeepRequest = z.infer<typeof supportKeepRequestSchema>;
