// The name and summary the assistant drafts for a release (REQ-40 BC-14), and the rule that judges
// them. Every release is named once it is drafted or cut: by a person or a master where one names
// it, else by the assistant from the issues the release carries and nothing else: their notes, and
// the criteria of one with no note. A requirement those issues serve is never read for it, so a
// release carrying one criterion of it is never named for the rest. A draft that cannot be written is
// said, with why, on the release's page; it is never left as a silent null.

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

/**
 * Who names a release nobody has named (ISS-590): naming takes project.admin, so it is the project's
 * master where an account it acts as holds that, else the project's admins by name, else nobody.
 */
export const ReleaseNamerSchema = z.discriminatedUnion("to", [
	z.strictObject({ to: z.literal("master") }),
	z.strictObject({
		to: z.literal("admins"),
		names: z.array(z.string().min(1)).min(1),
	}),
	z.strictObject({ to: z.literal("nobody") }),
]);
export type ReleaseNamer = z.infer<typeof ReleaseNamerSchema>;

/**
 * What the namer is shown: the issues the release carries, each by its own note, or by its own
 * criteria where it has none. Never a requirement's scope: an issue under a requirement carries only
 * what it was cut to do.
 */
export interface ReleaseNamingFacts {
	version: string;
	/** Each change a user sees, from its note: its short title, where it has one, and its one sentence. */
	changes: { title: string | null; line: string }[];
	/** Each change nobody using the product sees (a `Skip` note): what it changes for whoever runs it. */
	operatorChanges: { title: string; line: string | null }[];
	/** Each carried issue with no note, by its title and its own criteria. */
	unnoted: { title: string; criteria: string[] }[];
	/**
	 * Where every change is one nobody using the product sees: the sentence its summary opens with, in
	 * the release's language (`usersUnchangedSentence`); null on any other release.
	 */
	usersUnchanged: string | null;
}

/**
 * What a release of operator changes only tells the people using the product (REQ-40 BC-16: changes
 * nobody using the product sees stay out of the overview): that nothing changed for them. In the
 * release's content language, English where it has no sentence of its own.
 */
const USERS_UNCHANGED: Record<string, string> = {
	en: "Nothing changes for the people using the product.",
	vi: "Không có thay đổi nào với người dùng sản phẩm.",
};

export function usersUnchangedSentence(language: string): string {
	const base = language.toLowerCase().split("-")[0] ?? "en";
	return USERS_UNCHANGED[base] ?? (USERS_UNCHANGED.en as string);
}

/** Whether the release carries anything to name it from. */
export function namingHasFacts(facts: ReleaseNamingFacts): boolean {
	return (
		facts.changes.length > 0 ||
		facts.operatorChanges.length > 0 ||
		facts.unnoted.length > 0
	);
}

/** Whether every change the release carries is one nobody using the product sees. */
export function namingForOperatorsOnly(facts: ReleaseNamingFacts): boolean {
	return (
		facts.changes.length === 0 &&
		facts.unnoted.length === 0 &&
		facts.operatorChanges.length > 0
	);
}

const NUMERAL = /\d+(?:[.,:]\d+)*/g;

/**
 * Every reason a drafted name may not be written, by the code a refusal names it with; an empty list
 * means it may. The shape and sentence rules are `ReleaseNamingSchema`'s; on top, a reader of the
 * overview meets no engineer's reference (BC-15), no figure the release's record does not state, and
 * on a release of operator changes only, no summary that does not open by saying its users see none (BC-16).
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
	if (
		facts.usersUnchanged !== null &&
		!naming.summary.trim().startsWith(facts.usersUnchanged)
	)
		out.push({
			code: "RELEASE_NAMING_USERS_UNCHANGED",
			path: "summary",
			detail: `every change in this release is one only those who run the product see, so its summary opens with "${facts.usersUnchanged}" and then says what changed for them`,
		});
	const record = [
		facts.version,
		facts.usersUnchanged ?? "",
		...facts.changes.flatMap((c) => [c.title ?? "", c.line]),
		...facts.operatorChanges.flatMap((c) => [c.title, c.line ?? ""]),
		...facts.unnoted.flatMap((u) => [u.title, ...u.criteria]),
	].join(" ");
	const backed = new Set(record.match(NUMERAL) ?? []);
	for (const n of `${naming.name} ${naming.summary}`.match(NUMERAL) ?? [])
		if (!backed.has(n))
			out.push({
				code: "RELEASE_NAMING_FIGURE_UNBACKED",
				path: "",
				detail: `"${n}" is not a figure the release's changes state`,
			});
	return out;
}
