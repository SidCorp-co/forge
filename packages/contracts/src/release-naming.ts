// The name and summary the assistant drafts for a release (REQ-40 BC-14), and the rule that judges
// them. Every release is named once it is drafted or cut: by a person or a master where one names
// it, else by the assistant from what the release carries — each change's line for users and the
// requirements it completes or advances, nothing else. A draft that cannot be written is said, with
// why, on the release's page; it is never left as a silent null.

import { z } from "zod";
import { releaseNoteReferences } from "./content-language.js";
import type { Refusal } from "./refusal.js";
import { type ReleaseNaming, ReleaseNamingSchema } from "./release-notes.js";

/**
 * Where a release's name stands: `named` once it carries one; `drafting` while the assistant owes
 * its draft; `failed` with every reason the last draft was refused for, until it is named.
 */
export const ReleaseNamingStandingSchema = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("named") }),
	z.strictObject({
		state: z.literal("drafting"),
		since: z.iso.datetime({ offset: true }),
	}),
	z.strictObject({
		state: z.literal("failed"),
		at: z.iso.datetime({ offset: true }),
		refusals: z
			.array(
				z.strictObject({
					code: z.string(),
					path: z.string(),
					detail: z.string(),
				}),
			)
			.min(1),
	}),
]);
export type ReleaseNamingStanding = z.infer<typeof ReleaseNamingStandingSchema>;

/** What the namer is shown: the release's changes as users read them, and the requirements it carries. */
export interface ReleaseNamingFacts {
	version: string;
	/** Each change a user sees: its short title, where its note has one, and its one sentence. */
	changes: { title: string | null; line: string }[];
	requirements: {
		key: string;
		title: string;
		/** The requirement's summary, where it has one. */
		text: string;
		completes: boolean;
	}[];
}

/** Whether there is anything to name the release from: a change users see, or a requirement it carries. */
export function namingHasFacts(facts: ReleaseNamingFacts): boolean {
	return facts.changes.length > 0 || facts.requirements.length > 0;
}

const NUMERAL = /\d+(?:[.,:]\d+)*/g;

/**
 * Every reason a drafted name may not be written, by the code a refusal names it with; an empty list
 * means it may. The shape and sentence rules are `ReleaseNamingSchema`'s; on top, a reader of the
 * overview meets no engineer's reference (BC-15), and no figure the release's record does not state.
 */
export function judgeNaming(raw: unknown, facts: ReleaseNamingFacts): Refusal[] {
	const parsed = ReleaseNamingSchema.safeParse(raw);
	if (!parsed.success)
		return parsed.error.issues.map((i) => ({
			code: "RELEASE_NAMING_SHAPE",
			path: i.path.join("."),
			detail: i.message,
		}));
	const out: Refusal[] = [];
	const naming: ReleaseNaming = parsed.data;
	for (const field of ["name", "summary"] as const) {
		const found = releaseNoteReferences(naming[field]);
		if (found.length > 0)
			out.push({
				code: "RELEASE_NAMING_JARGON",
				path: field,
				detail: `${field} carries ${found.join(", ")}: a person using the product cannot follow these`,
			});
	}
	const record = [
		facts.version,
		...facts.changes.flatMap((c) => [c.title ?? "", c.line]),
		...facts.requirements.flatMap((r) => [r.title, r.text]),
	].join(" ");
	const backed = new Set(record.match(NUMERAL) ?? []);
	for (const n of `${naming.name} ${naming.summary}`.match(NUMERAL) ?? [])
		if (!backed.has(n))
			out.push({
				code: "RELEASE_NAMING_FIGURE_UNBACKED",
				path: "",
				detail: `"${n}" is not a figure the release's changes or requirements state`,
			});
	return out;
}
