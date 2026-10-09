// A draft nobody touched for a week is a decision, not a wait (REQ-41 BC-12; Requirement lifecycle
// `draft`): core asks one merge-or-drop question about it, with a recommended answer read from the
// product record (`core/src/requirements/stale-drafts.ts`). Before that it is `awaiting_proposal`
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
