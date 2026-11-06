// One declaration of what core records as having reached a run (ISS-1065): each rule, knowledge
// entry, lesson and memory a run session was given, how it reached it, and when. Core's table CHECKs,
// its recorder and the read route import the vocabularies and the answer's shape from here.

import { z } from "zod";

/** What reached a run: an always-applied rule, a knowledge entry, a lesson or a memory. */
export const RUN_CONTEXT_SOURCE_KINDS = [
	"rule",
	"knowledge",
	"lesson",
	"memory",
] as const;
export type RunContextSourceKind = (typeof RUN_CONTEXT_SOURCE_KINDS)[number];

/**
 * How it reached the run: composed into its prompt or orientation, returned by a knowledge get, or
 * returned by a knowledge or memory search.
 */
export const RUN_CONTEXT_HOWS = ["prompt", "get", "search"] as const;
export type RunContextHow = (typeof RUN_CONTEXT_HOWS)[number];

/**
 * One source as it reached a run. `ref` is a knowledge, rule or lesson slug, or a memory's id.
 * `revision` is the source's `updatedAt` (a memory's `asOf`) where the read carried one, else
 * `sha256:<16 hex>` of the text the run was given, so either names the version that was in force.
 */
export interface RunContextSource {
	kind: RunContextSourceKind;
	ref: string;
	revision: string | null;
}

/**
 * The header a run's box credential names its run by on a read, where several runs share the box's
 * credential (a master's declared runs): the session id, core's run id or the box's own run id.
 */
export const RUN_CONTEXT_RUN_HEADER = "x-forge-run";

/** The text of a source as a revision, where the read carried no timestamp. */
export const RUN_CONTEXT_DIGEST_PREFIX = "sha256:";

/** At most this many rows answer one read; `truncated` says when more were recorded. */
export const RUN_CONTEXT_READ_LIMIT = 2000;

export const RUN_CONTEXT_QUERY_SHAPE =
	"exactly one of session=<agent session uuid> or issue=<issue uuid>";

export const runContextQuerySchema = z
	.strictObject({
		session: z.uuid().optional(),
		issue: z.uuid().optional(),
	})
	.refine((q) => (q.session === undefined) !== (q.issue === undefined), {
		message: `send ${RUN_CONTEXT_QUERY_SHAPE}`,
	});
export type RunContextQuery = z.infer<typeof runContextQuerySchema>;

/** One reach: what reached which run, for which issue, how and when. */
export interface RunContextReach extends RunContextSource {
	how: RunContextHow;
	/** The agent session the source reached. */
	sessionId: string;
	/** The issue that session worked, or null for a session working none (a master, a chat turn). */
	issueId: string | null;
	at: string;
}

/**
 * What a run or an issue was given, in the order it reached them. `unrecorded` counts, since this
 * process started, the reaches it could not record: `failed` where the write itself failed, and
 * `unattributed` where a box credential read a source and no single run could be named. A non-zero
 * count says this record may be missing reaches, never that there were none.
 */
export interface RunContextView {
	subject: { session: string } | { issue: string };
	reached: RunContextReach[];
	truncated: boolean;
	unrecorded: { failed: number; unattributed: number; since: string };
}
