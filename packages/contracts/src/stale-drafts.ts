// A draft nobody touched for a week is a decision, not a wait (REQ-41 BC-12; Requirement lifecycle
// `draft`): core asks one merge-or-drop question about it, with a recommended answer read from the
// product record (`core/src/requirements/stale-drafts.ts`), and carries the answer out by itself
// (`core/src/requirements/stale-draft-act.ts`). Before that it is `awaiting_proposal`
// (`./needs-you-decisions.ts`), which is not a decision. The option ids are the question's mark: the
// needs-me read files a question carrying them under `merge_or_drop`, and the sweep reads them to ask
// once per stale spell.

/** Untouched this many days, a draft requirement, draft revision or draft issue is asked about. */
export const DRAFT_STALE_DAYS = 7;

/** The three answers a merge-or-drop question offers, by their option ids. */
export const STALE_DRAFT_OPTION_IDS = {
	merge: "stale_draft.merge",
	drop: "stale_draft.drop",
	keep: "stale_draft.keep",
} as const;
export type StaleDraftAnswer = keyof typeof STALE_DRAFT_OPTION_IDS;

/** The jsonb a merge-or-drop question's first round options contain, for a Postgres `@>` test. */
export const STALE_DRAFT_ASKED_MARK = JSON.stringify([
	{ id: STALE_DRAFT_OPTION_IDS.drop },
]);

/**
 * Why core did not carry an answer out by itself, recorded on the answered round; the draft then
 * waits on the master, never on nothing. A refusal a service gave (a revision already open on the
 * target, a transition the machine refuses) is recorded under that service's own code.
 */
export const STALE_DRAFT_ACT_REFUSALS = [
	"STALE_DRAFT_MERGE_NO_TARGET",
	"STALE_DRAFT_MERGE_TARGET_ENDED",
	"STALE_DRAFT_MERGE_HAS_DEPENDENTS",
	"STALE_DRAFT_MERGE_REVISION",
] as const;
export type StaleDraftActRefusal = (typeof STALE_DRAFT_ACT_REFUSALS)[number];

/** What an answered round's `resume` records where core refused to carry the answer out. */
export interface StaleDraftRefused {
	code: string;
	detail: string;
}

/**
 * The refusal the newest merge-or-drop question on a draft carries, read from its status and its
 * last round's `resume`; null while it is open, or where its answer was carried out.
 */
export function staleDraftRefusedOf(
	status: string,
	resume: { kind?: string; code?: string; detail?: string } | null | undefined,
): StaleDraftRefused | null {
	if (status !== "answered" || resume?.kind !== "refused") return null;
	return {
		code: String(resume.code ?? ""),
		detail: String(resume.detail ?? ""),
	};
}

const IDS = new Set<string>(Object.values(STALE_DRAFT_OPTION_IDS));

/** Whether a round's options are a merge-or-drop question's: it offers the drop and the keep. */
export function isStaleDraftQuestion(
	options: readonly { id: string }[] | undefined,
): boolean {
	const ids = new Set(
		(options ?? []).map((o) => o.id).filter((id) => IDS.has(id)),
	);
	return (
		ids.has(STALE_DRAFT_OPTION_IDS.drop) && ids.has(STALE_DRAFT_OPTION_IDS.keep)
	);
}
