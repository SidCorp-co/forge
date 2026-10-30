import type {
	ChangedTrace,
	OtherProject,
	RequirementBaseline,
	RequirementRevision,
	RequirementStatus,
} from "./requirements.js";

/**
 * The requirement an issue delivers, read through the issue (`GET /api/issues/:id/requirement`, and
 * `requirement` on `forge_issues get`). It is authorised on the issue's project alone, so a run whose
 * credential is fenced to that project reads a sibling project's requirement it delivers; it answers
 * that one requirement's text and nothing else of the project holding it.
 */
export interface IssueRequirementRead {
	issueId: string;
	/** Null where the issue delivers no requirement. */
	requirement: IssueDeliveredRequirement | null;
}

export interface IssueDeliveredRequirement {
	id: string;
	/** `REQ-n` on its own project. */
	key: string;
	/** `<project-slug>/REQ-n` where it is another project's (`otherProject`), else `key`. */
	displayKey: string;
	/** The project holding it. */
	project: OtherProject;
	/** Its project, where it is not the issue's own (a sibling project of the issue's organization). */
	otherProject: OtherProject | null;
	title: string;
	status: RequirementStatus;
	currentRevision: number | null;
	/** The current revision as the requirement's own read serves it (spec, tldr, criteria with code and body); null while none is current. */
	revision: RequirementRevision | null;
	/** Its latest baseline: the revision agreed and what it pins. Null while it was never agreed. */
	agreed: RequirementBaseline | null;
	/** The revision the issue's plan was written against. */
	plannedRevision: number | null;
	/** The issue's plan no longer holds at the current revision (`requirements.ts:changedSincePlan`). */
	changedSincePlan: boolean;
	/** The BCs the issue traces that a revision after its plan's changed. */
	changedTraced: ChangedTrace[];
}
