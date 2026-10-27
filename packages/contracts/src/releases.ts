// one declaration of the release read model (REQ-11 BC-6, BC-12, ISS-71): core derives every
// fact in `release-batch/release-view.ts` and `release-batch/versions.ts`, and the Releases list,
// peek and page draw them, so a state keeps one badge and nobody derives whom a release waits on in
// the browser.

import { CHECKLIST_REFUSAL_CODES } from "./checklists.js";
import type { CriterionStanding, IssueStatusTone } from "./issue-vocabulary.js";
import type {
	ArtifactChange,
	LandingArtifact,
	LandingSurface,
} from "./landing-artifacts.js";
import type { RefusalStatuses } from "./refusal.js";
import type {
	BcVerdict,
	CriteriaCoverage,
	RequirementState,
} from "./requirements.js";
import type { Said } from "./said.js";
import type {
	Standing,
	StandingGroup,
	StandingGroupLabels,
	WaitingKind,
	WaitingOn,
} from "./standing.js";

export const VERSION_STATUSES = [
	"in_progress",
	"awaiting_approval",
	"returned",
	"shipped",
	"landed",
	"failed",
	"aborted",
] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const RELEASE_STATES = ["draft", ...VERSION_STATUSES] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

export const RELEASE_STATE_LABELS: Record<ReleaseState, string> = {
	draft: "Draft",
	in_progress: "In progress",
	awaiting_approval: "Awaiting approval",
	returned: "Returned",
	shipped: "Shipped",
	landed: "Landed",
	failed: "Failed",
	aborted: "Aborted",
};

export const RELEASE_STATE_TONES: Record<ReleaseState, IssueStatusTone> = {
	draft: "neutral",
	in_progress: "run",
	awaiting_approval: "you",
	returned: "err",
	shipped: "ready",
	landed: "neutral",
	failed: "err",
	aborted: "neutral",
};

export const RELEASE_STATE_GLYPHS: Record<ReleaseState, string> = {
	draft: "○",
	in_progress: "●",
	awaiting_approval: "↑",
	returned: "↺",
	shipped: "✓",
	landed: "↓",
	failed: "×",
	aborted: "–",
};

export const RELEASE_STATE_HINTS: Record<ReleaseState, string> = {
	draft: "draft: merged issues wait at the gate; no version holds them yet",
	in_progress:
		"in_progress: a release run is promoting, deploying or verifying the version",
	awaiting_approval:
		"awaiting_approval: no production act is taken until an admin approves",
	returned:
		"returned: an admin sent it back; the master answers before asking again",
	shipped: "shipped: the release run stamped the version released",
	landed:
		"landed: it landed on a branch production does not deploy from",
	failed: "failed: the release run ended without shipping",
	aborted: "aborted: the release run was stopped on purpose",
};

export const RELEASE_ATTENTION_GROUPS = [
	"needs_you",
	"moving",
	"waiting",
	"queued",
	"stuck",
	"done",
	"stopped",
] as const satisfies readonly StandingGroup[];
export type ReleaseAttentionGroup = (typeof RELEASE_ATTENTION_GROUPS)[number];

export const RELEASE_ATTENTION_LABELS: StandingGroupLabels<ReleaseAttentionGroup> =
	{
		needs_you: {
			label: "Needs you",
			tone: "you",
			collapsed: false,
		},
		moving: {
			label: "Moving",
			tone: "run",
			collapsed: false,
		},
		waiting: {
			label: "Someone else’s turn",
			tone: "neutral",
			collapsed: false,
		},
		queued: {
			label: "Queued",
			tone: "neutral",
			collapsed: false,
		},
		stuck: {
			label: "Stuck",
			tone: "err",
			collapsed: false,
		},
		done: {
			label: "Shipped",
			tone: "done",
			collapsed: false,
		},
		stopped: {
			label: "Stopped",
			tone: "neutral",
			collapsed: true,
		},
	};

export const RELEASE_WAITING_KINDS = [
	"you",
	"person",
	"agent",
	"system",
	"none",
] as const satisfies readonly WaitingKind[];
export type ReleaseWaitingKind = (typeof RELEASE_WAITING_KINDS)[number];

export interface ReleasePerson {
	id: string;
	name: string;
	kind: "human" | "agent";
}

/**
 * What a release, or one issue it carries, proves of its criteria, by the verified rule (core
 * contracts `verified-rule.ts:verifiedOf`, REQ-35 decision 7b261fca): `unproven` is judged and not proven — a short,
 * or a pass the rule does not count — never "not judged yet".
 */
export const RELEASE_PROOFS = [
	"proven",
	"failing",
	"open",
	"unproven",
	"unrecorded",
] as const;
export type ReleaseProof = (typeof RELEASE_PROOFS)[number];

export const RELEASE_PROOF_LABELS: Record<ReleaseProof, string> = {
	proven: "Proven",
	failing: "Failing",
	open: "Not judged yet",
	unproven: "Judged, not proven",
	unrecorded: "No criteria",
};

export const RELEASE_PROOF_TONES: Record<ReleaseProof, IssueStatusTone> = {
	proven: "ready",
	failing: "err",
	open: "neutral",
	unproven: "neutral",
	unrecorded: "neutral",
};

export interface ReleaseCriteriaTotals {
	/** Proven by the verified rule: a pass it counts. */
	proven: number;
	failing: number;
	/** Not judged on the build: no verdict, skipped, or unresolved. */
	open: number;
	/** Judged and not proven: a short, or a pass the verified rule does not count. */
	unproven: number;
	total: number;
}

export interface ReleaseContentIssue {
	/** The issue's id, what a cut names it by (`POST …/release-batches {issueIds}`). */
	id: string;
	key: string;
	title: string;
	status: string;
	proof: ReleaseProof;
	/** The change request that delivers it, where one is linked (REQ-63 BC-5). */
	changeRequest: ReleaseChangeRequest | null;
}

export interface ReleaseContentGroup {
	requirement: { key: string; title: string } | null;
	issues: ReleaseContentIssue[];
}

export interface ReleaseSplit {
	/** Oldest merge first, at most RELEASE_ROSTER_LIMIT. */
	issueIds: string[];
	/** How many stay at the release gate for the next release. */
	rest: number;
}

/**
 * What outside Forge can carry a release's version once an attempt has worn it (ADR 0011): a pushed
 * `tag`, a release `commit` on a branch (its changelog entry or version bump), a published
 * `artifact` (a package, an image, a storefront release that names the version), or a `notice` sent
 * to people. Any one of them makes the next attempt take a new version, and the page names it.
 */
export const RELEASE_VERSION_CARRIER_KINDS = [
	"tag",
	"commit",
	"artifact",
	"notice",
] as const;
export type ReleaseVersionCarrierKind =
	(typeof RELEASE_VERSION_CARRIER_KINDS)[number];

export interface ReleaseVersionCarrier {
	kind: ReleaseVersionCarrierKind;
	/** As the outside world names it: `v0.3.0`, `@acme/app@0.3.0`, "release notes emailed to customers". */
	name: string;
}

/**
 * How an attempt came to wear its version: `first` cut of a roster nothing cut before, `reused` from
 * the attempt before it on the same roster, `bumped` past it because something outside Forge
 * carries that one, another release already wears it, or the declared prerelease line moved off it; `unrecorded` on a run cut before the
 * rule was recorded on the run.
 */
export const RELEASE_VERSION_DECISIONS = [
	"first",
	"reused",
	"bumped",
	"unrecorded",
] as const;
export type ReleaseVersionDecision = (typeof RELEASE_VERSION_DECISIONS)[number];

export interface ReleaseVersionRule {
	decided: ReleaseVersionDecision;
	/** The version the attempt before this one wore; null on a first cut and where unrecorded. */
	from: string | null;
	/** Where `bumped` for what carries `from`: each artifact, as recorded. */
	carriers: ReleaseVersionCarrier[];
	/** Where `bumped` because the prerelease line moved: the line now declared, `<of>-<label>`. */
	line: string | null;
	/** Where `bumped` because another release's attempt already wears `from` (one cut before ADR 0011 handed it on). */
	taken: boolean;
}

/** One attempt at a release: one cut of its roster, how it ended and who ended it. */
export interface ReleaseCutView {
	/** 1-based, in the order the attempts were cut. */
	n: number;
	runId: string;
	/** The version this attempt wore; an attempt cut before ADR 0011 may wear another than the release. */
	version: string;
	cutAt: string;
	cutBy: ReleasePerson | null;
	outcome: VersionStatus;
	endedAt: string | null;
	/** The finish refusal that ended it: its code, its text word for word, and what it means said by key (`releases.refused.*`). */
	refusal: { code: string | null; text: string; says: Said } | null;
	/** The abort's own reason, word for word, where it was aborted. */
	abortReason: string | null;
	/** Who ended it: the abort's or the finish's actor; null where Forge ended it itself or it is still open. */
	decidedBy: ReleasePerson | null;
	rule: ReleaseVersionRule;
	/** What outside Forge carries this attempt's version: `[]` where it was said nothing does, `null` where nobody said. */
	carried: ReleaseVersionCarrier[] | null;
	/** The issues this attempt was cut with (`metadata.issueIds`), in key order: its own roster, not the release's last. */
	roster: { key: string; title: string }[];
}

/** Where a version that did not ship went: the release that carried the same roster on. */
export interface ReleaseContinuation {
	version: string;
	shipped: boolean;
}

export interface ReleaseSummary
	extends Standing<ReleaseAttentionGroup, ReleaseWaitingKind> {
	key: string;
	version: string;
	runId: string | null;
	state: ReleaseState;
	current: boolean;
	/**
	 * The branch a recorded landing put it on, where that is not the branch production deploys from
	 * (state `landed`): production does not serve it. Null on every other release.
	 */
	landedOn: string | null;
	/** The release's name and its two-to-three-sentence summary, written when it was cut (REQ-40 BC-14); null until written, and on a draft nobody cut. */
	name: string | null;
	summary: string | null;
	issueCount: number;
	requirements: string[];
	criteria: ReleaseCriteriaTotals;
	/** What was verified, in one level a reader states in words (JU-11). */
	verified: ReleaseVerified;
	contents: ReleaseContentGroup[];
	owner: ReleasePerson | null;
	ownerAct: string | null;
	/**
	 * `split`: the draft is refused for one reason only, RELEASE_ROSTER_OVERSIZE, and the viewer is
	 * an admin — the act that gate names, cutting `split.issueIds` as this release.
	 */
	can: { cut: boolean; decide: boolean; split: boolean };
	/** What a split cuts: the oldest RELEASE_ROSTER_LIMIT merged issues; `rest` stay at the gate. */
	split: ReleaseSplit | null;
	openedAt: string | null;
	releasedAt: string | null;
	at: string;
	/** How many attempts this release has been cut in; 0 on a draft nobody cut yet. */
	cutCount: number;
	/** Where this version's roster went on, when a later attempt wears another version; null otherwise. */
	continuedAs: ReleaseContinuation | null;
}

/**
 * How a release's close is proved: `probed` by production's source probes, `deployment` by the
 * commit production's deployment record names, `provider` by what a storefront provider reports it
 * serves against what each issue landed — workflows, routes, pages, the theme and store settings, or
 * a design approval's record (core `release-batch/provider-verify.ts`).
 * `unverified` is a close from before the deployment check, kept as it was recorded. `landed` is a
 * project that declares no production environment: its landing on the working branch is the
 * delivery, nothing was deployed, and no deploy is checked (core `release-batch/recorded-landing.ts`).
 */
export const RELEASE_VERIFICATIONS = [
	"probed",
	"deployment",
	"provider",
	"unverified",
	"landed",
] as const;
export type RecordedReleaseVerification =
	(typeof RELEASE_VERIFICATIONS)[number];

/** How this release is (or, before its run records it, will be) proved, and through which provider. */
export interface ReleaseVerifiedBy {
	kind: RecordedReleaseVerification;
	/** The production binding's provider as a person reads it (`Autoflow`), or `null` where none is bound. */
	provider: string | null;
}

/**
 * What a release verified, read off its criteria and how its run proves the deploy:
 * `criteria` every recorded criterion proven; `some_criteria` some recorded and not all proven;
 * `deploy_only` no criterion recorded and only the deploy checked; `none` neither. A reader is told
 * the level in words, so a deploy probe is never read as proof of the change (JU-11).
 */
export const RELEASE_VERIFIED_LEVELS = [
	"criteria",
	"some_criteria",
	"deploy_only",
	"none",
] as const;
export type ReleaseVerifiedLevel = (typeof RELEASE_VERIFIED_LEVELS)[number];

export interface ReleaseVerified {
	level: ReleaseVerifiedLevel;
	proven: number;
	total: number;
	/** How the run recorded the deploy proved; null on the draft and on a run that recorded none. */
	check: RecordedReleaseVerification | null;
	/**
	 * Where `check` is `provider`, the production binding's provider as a person reads it
	 * (`Autoflow`), so the sentence names who served it; null on any other check or where none is bound.
	 */
	provider: string | null;
	/**
	 * The testing environment `proven` was counted on (`delivery.judgedOn`, REQ-36 BC-18): a pass
	 * judged on the build it serves; null where a commit verdict at the release's build counts (BC-20).
	 */
	judgedOn: string | null;
}

/** The one rule for `ReleaseVerified.level`, so every surface states the same level. */
export function releaseVerifiedLevel(
	criteria: Pick<ReleaseCriteriaTotals, "proven" | "total">,
	check: RecordedReleaseVerification | null,
): ReleaseVerifiedLevel {
	if (criteria.total > 0) {
		return criteria.proven === criteria.total ? "criteria" : "some_criteria";
	}
	// A landing deployed nothing, so no deploy check stands in for the criteria.
	return check !== null && check !== "unverified" && check !== "landed"
		? "deploy_only"
		: "none";
}

export type ReleaseProduction =
	| {
			ok: true;
			name: string | null;
			url: string | null;
			serving: string | null;
	  }
	| { ok: false; reason: string };

/**
 * A landing recorded as the release of a project that declares no production environment before a
 * recorded landing took a version (core `release-batch/recorded-landing.ts`, 2026-10-26): no
 * version and no deploy, only the branch and commit its issues landed at. It claimed no number when
 * it was recorded and is given none after (ADR 0011); every landing since is a release on the list.
 */
export interface ReleaseLanding {
	runId: string;
	branch: string;
	commit: string;
	at: string;
	/** The issues it named, by key. */
	issues: string[];
	/** False where some issue it named would not close, so the record ended failed. */
	closedAll: boolean;
}

export interface ReleaseListResponse {
	releases: ReleaseSummary[];
	counts: Record<ReleaseAttentionGroup, number>;
	approvalRequired: boolean;
	production: ReleaseProduction;
	/** Landings recorded before versioning, newest first, on any project; versioned ones are `releases`. */
	landings: ReleaseLanding[];
}

export interface ReleaseIssueView {
	id: string;
	key: string;
	title: string;
	status: string;
	section: string | null;
	requirement: string | null;
	proof: ReleaseProof;
	criteria: ReleaseCriteriaTotals;
	waitingOn: WaitingOn<ReleaseWaitingKind>;
	/** The surfaces its landing touches, in `LANDING_SURFACES` order; empty where none is named. */
	surfaces: LandingSurface[];
	landing: IssueLandingReading;
	/** True where some of what its landing changed is named by no surface (core `landing-surfaces.ts:gapOf`). */
	unclassified: boolean;
	/** The change request that delivers it, where one is linked (REQ-63 BC-5). */
	changeRequest: ReleaseChangeRequest | null;
}

/**
 * What an issue's landing says it changed. `named`: the artifacts, with any changed paths the
 * project's surface map claims for none. `unclassified`: nothing structured names them — a prose
 * landing, a commit not read, a project declaring no surface map — with why, and the paths where
 * they were read.
 */
export type IssueLandingReading =
	| {
			kind: "named";
			artifacts: LandingArtifact[];
			unmappedPaths: string[];
			/** Why the commit's paths were not read, beside artifacts the row names of its own. */
			unread: string | null;
			source: LandingReadingSource;
	  }
	| {
			kind: "unclassified";
			why: string;
			paths: string[];
			/** Who read the paths shown, where any were read. */
			source: Exclude<LandingReadingSource, "mark"> | null;
	  };

/**
 * Who named what a landing changed: `mark` — the mark or a design approval named it; `host` — the
 * source host's record of the observed commit; `box` — a box read the commit's paths from its own
 * checkout and sent them with the mark, which is the box's reading, not a merge Forge observed.
 */
type LandingReadingSource = "mark" | "host" | "box";

interface ReleaseChangeArtifact {
	ref: string;
	change: ArtifactChange;
	/** The issue keys whose landings name it. */
	issues: string[];
	/** The issue whose own release ships it, where a mark says it is carried; null where this release ships it. */
	carriedBy: string | null;
}

export interface ReleaseSurfaceChanges {
	surface: LandingSurface;
	/** How many distinct artifacts it names. */
	count: number;
	/** True for `design`: a design revision deploys nothing. */
	shipsNothing: boolean;
	issues: string[];
	artifacts: ReleaseChangeArtifact[];
}

const RELEASE_CHANGE_RISKS = [
	"data_removed",
	"data_changed",
	"api_removed",
] as const;
type ReleaseChangeRisk = (typeof RELEASE_CHANGE_RISKS)[number];

export interface ReleaseChangeRiskView {
	risk: ReleaseChangeRisk;
	surface: LandingSurface;
	ref: string;
	issues: string[];
	sentence: string;
	/** `sentence` as said (`said.ts`). */
	says: { sentence: Said };
}

/** "What changes": per surface, what the release's landings name, and what the data flags. */
export interface ReleaseChanges {
	surfaces: ReleaseSurfaceChanges[];
	risks: ReleaseChangeRiskView[];
	/**
	 * Issues whose landing leaves something unnamed — all of it, or paths no surface claims — with why.
	 * `key` is null for paths a release's commit range changed that no rule claims and no issue names.
	 */
	unclassified: { key: string | null; why: string; paths: string[] }[];
	/** Issues whose paths a box read from its checkout rather than Forge observing the merge. */
	boxRead: string[];
	/** True where every classified artifact ships nothing and nothing is unclassified. */
	shipsNothing: boolean;
}

export interface ReleaseRequirementView {
	key: string;
	title: string;
	state: RequirementState;
	completes: boolean;
	advances: { code: string; verdict: BcVerdict }[];
	remaining: { issues: string[]; criteria: string[] };
	/** The requirement's own criteria counted from its coverage, so a bar reads passed out of the total. */
	coverage: CriteriaCoverage;
}

export interface ReleaseCriterionView {
	n: number;
	statement: string;
	standing: CriterionStanding;
	bc: string | null;
	identity: string | null;
	reason: string | null;
	judgedAt: string | null;
	judgedBy: "human" | "agent" | null;
	/** Whether the release counts it proven, by the verified rule (contracts `verified-rule.ts:verifiedOf`). */
	proven: boolean;
	/** Where its pass or short does not count as proven, why; null otherwise. */
	unverified: string | null;
}

export interface ReleaseIssueCriteria {
	key: string;
	title: string;
	criteria: ReleaseCriterionView[];
}

export interface ReleaseNoteEntry {
	key: string;
	/** The issue's title, so a reader names the change by it and not by the bare key. */
	title: string;
	/** The note's short title a reader scans (REQ-40 BC-6); null on a note written before titles, whose `userFacing` is shown whole instead. */
	heading: string | null;
	userFacing: string;
	technical: string | null;
	/** What an admin must do before this change goes out, as its note says (REQ-40 BC-7). */
	adminSteps: string[];
}

export interface ReleaseNoteAttentionView {
	key: string;
	title: string;
	notInLanguage: boolean;
	references: string[];
}

export interface ReleaseNoteSection {
	section: string;
	entries: ReleaseNoteEntry[];
}

/** Who owes the act that clears a gate: the project's master where the remedy is an act on the
 *  issues it names, a project admin where it is the project's own configuration or boxes, and the
 *  release gate itself where nothing but time or a retry clears it. */
const RELEASE_GATE_OWNERS = ["agent", "person", "system"] as const;
type ReleaseGateOwnerKind = (typeof RELEASE_GATE_OWNERS)[number];

export interface ReleaseGateOwner {
	kind: ReleaseGateOwnerKind;
	/** Sentence-case: "Master", "A project admin", "Release gate". */
	who: string;
	/** Lower-case after the name: "write the release note on ISS-6, ISS-11". */
	act: string;
	/** What doing the act changes, where the act's own words leave that open. */
	effect?: string;
	/** `who`, `act` and `effect` as said (`said.ts`). */
	says: { who: Said; act: Said; effect?: Said };
}

export interface ReleaseGateView {
	code: string;
	kind: "blocker" | "warning";
	title: string;
	sentence: string;
	detail: string;
	issues: string[];
	owner: ReleaseGateOwner;
	/** `title` and `sentence` as said (`said.ts`). */
	says: { title: Said; sentence: Said };
}

export interface ReleaseApprovalView {
	id: string;
	requestedBy: ReleasePerson;
	requestedAt: string;
	/** `environment` is null on a change-request release, whose evidence is its change requests' heads (REQ-63). */
	evidence: { environment: string | null; commit: string; reading: string };
	note: string | null;
	decision: "approved" | "returned" | null;
	decidedBy: ReleasePerson | null;
	decidedAt: string | null;
	reason: string | null;
}

/** Who owes the act that clears a release hold. */
export const RELEASE_HOLD_OWERS = ["agent", "human"] as const;
export type ReleaseHoldOwer = (typeof RELEASE_HOLD_OWERS)[number];

/** Why the automatic release is not taking an issue at its gate, as the sweep last decided it. */
export interface ReleaseHoldView {
	code: string;
	reason: string;
	owes: ReleaseHoldOwer;
	waitingFor: string;
	heldAt: string;
}

/** `deploy`: a production deploy a release run dispatched (`release-coolify.ts`); `verify`: a recorded release's reading (`recorded.ts`). */
export const RELEASE_ATTEMPT_STAGES = ["deploy", "verify"] as const;
export type ReleaseAttemptStage = (typeof RELEASE_ATTEMPT_STAGES)[number];

export interface ReleaseAttemptView {
	id: string;
	stage: ReleaseAttemptStage;
	verdict: "ok" | "failed" | "unverified" | null;
	health: "up" | "down" | null;
	commit: string | null;
	providerRef: string | null;
	identity: string | null;
	readings: string[];
	verdictReason: string | null;
	account: string | null;
	startedAt: string;
	settledAt: string | null;
}

/**
 * One feedback item the release's issues carry: who reported it and whether the release told them.
 * `on_ship` until the release ships; then `told` off the notice, or `not_told` (an agent has no bell,
 * the reporter turned it off, or the notice never went).
 */
export interface ReleaseFeedbackView {
	key: string;
	title: string;
	reporter: string;
	agency: "human" | "agent";
	/** `before_notices`: it shipped before this project's first release notice, so none was owed. */
	told: "on_ship" | "told" | "not_told" | "before_notices";
	toldAt: string | null;
}

export interface ReleaseDetail extends ReleaseSummary {
	/** The feedback this release answers, by key: what the people who asked are waiting to hear. */
	feedbackAnswered: ReleaseFeedbackView[];
	/** `feedbackAnswered` counted by whether each reporter was told. */
	feedbackToldCounts: Record<ReleaseFeedbackView["told"], number>;
	issues: ReleaseIssueView[];
	requirementsCompleted: ReleaseRequirementView[];
	issueCriteria: ReleaseIssueCriteria[];
	changes: ReleaseChanges;
	notes: {
		sections: ReleaseNoteSection[];
		/** Issues whose landing touched only a design: approved designs, which users do not get as a change. */
		designs: ReleaseNoteEntry[];
		withoutNotes: { key: string; title: string }[];
		/** Issues whose note says nobody using the product sees them (`Skip`): counted apart (REQ-40 BC-16). */
		skipped: ReleaseNoteEntry[];
		/**
		 * Issues reopened after this release claimed them: their note and landing now say a later
		 * round, which this release did not ship, so neither is read as this release's.
		 */
		reworked: { key: string; title: string }[];
		/** The language the project's notes are written in (BCP-47). */
		language: string;
		/** Notes whose user-facing line is not in `language` or carries an engineer's reference. A reader aid, not a gate. */
		attention: ReleaseNoteAttentionView[];
	};
	gates: ReleaseGateView[];
	approval: ReleaseApprovalView | null;
	approvals: ReleaseApprovalView[];
	approvers: ReleasePerson[];
	approvalRequired: boolean;
	attempts: ReleaseAttemptView[];
	/** Every attempt at this release, first first (ADR 0011). */
	cuts: ReleaseCutView[];
	production: { name: string | null; url: string | null } | null;
	/**
	 * The project releases by merging its change requests and its owner deploys (`release.changeRequests`):
	 * the release ends at its last merge, and names no production of its own (REQ-71 BC-6).
	 */
	ownerDeploys: boolean;
	/** `null` where the run recorded no verification and the project declares no way to prove one. */
	verifiedBy: ReleaseVerifiedBy | null;
	head: string | null;
}

export interface ReleaseResponse {
	release: ReleaseDetail;
}

/** Every reason a release will not start, in the order the doors refuse in (ISS-1127). */
/** What an issue with no release note is told to do before it can ship. */
export const RELEASE_RECORD_REMEDY =
	"Set `releaseNotes` first: `{ section, userFacing }` with the one plain-language line a " +
	"user would read, or `{ section: 'Skip', userFacing: '-' }` when the change has no " +
	"user-facing half.";

export const RELEASE_BLOCKER_CODES = [
	"NO_RELEASE_GATE",
	"RELEASE_TARGET_UNDECLARED",
	"CLAIM_CONFLICT",
	"RELEASE_ROSTER_EMPTY",
	"RELEASE_ROSTER_OVERSIZE",
	"RELEASE_RECORD_MISSING",
	"RELEASE_WORK_UNMERGED",
	"RELEASE_PROBES_UNREADABLE",
	"RELEASE_POOL_EMPTY",
	"NO_RUNNER_ONLINE",
	"BATCH_IN_FLIGHT",
	"RELEASE_VERSION_UNDECIDED",
	"RELEASE_CRITERIA_UNEARNED",
	"RELEASE_RUNTIME_UNROUTED",
	"RELEASE_CHECK_UNEVALUATED",
	/** A change-request release whose roster issue has no open change request linked to it (REQ-63). */
	"RELEASE_CHANGE_REQUEST_MISSING",
	/** A change-request release whose change request delivers an issue the roster does not hold. */
	"RELEASE_CHANGE_REQUEST_CARRIES_UNRELEASED",
	/** A change-request project's landing recorded by hand, which would skip its approval and merges. */
	"RELEASE_THROUGH_CHANGE_REQUESTS",
] as const;
export type ReleaseBlockerCode = (typeof RELEASE_BLOCKER_CODES)[number];

const RELEASE_APPROVAL_REFUSAL_CODES = [
	"RELEASE_APPROVAL_SHAPE",
	"RELEASE_APPROVAL_PENDING",
	"RELEASE_APPROVAL_NOT_PENDING",
	"RELEASE_APPROVAL_EVIDENCE_ENVIRONMENT",
	"RELEASE_APPROVAL_PATH_UNREADABLE",
	"RELEASE_RUN_CONCLUDED",
	"RELEASE_DECISION_UNKNOWN",
	"RELEASE_RETURN_WITHOUT_REASON",
	"RELEASE_AWAITING_APPROVAL",
	"RELEASE_APPROVAL_RETURNED",
	"RELEASE_APPROVAL_REQUIRED",
	"RELEASE_VERSION_SHAPE",
] as const;
/** Every code a release door refuses with, in the one refusal envelope; `RELEASE_REFUSED` when several differ. */
export const RELEASE_REFUSAL_CODES = [
	"RELEASE_REFUSED",
	...CHECKLIST_REFUSAL_CODES,
	...RELEASE_BLOCKER_CODES,
	...RELEASE_APPROVAL_REFUSAL_CODES,
	"RELEASE_ISSUES_UNNAMED",
	"CONTRACT_PROVIDER_NOT_LIVE",
	"RELEASE_VERDICT_NOT_YOURS",
	"RELEASE_NOT_VERIFIED",
	/** Under release mode `none`, the record's commit is not a whole sha a landing can name. */
	"RELEASE_LANDING_COMMIT_SHAPE",
	/** Under release mode `none`, an issue whose merge records no commit, so nothing says what landed. */
	"RELEASE_LANDING_UNRECORDED",
	/** Under release mode `none`, an issue whose recorded merge is not in the record's commit. */
	"RELEASE_LANDING_NOT_IN_COMMIT",
	/** Under release mode `none`, an issue criterion with no counting pass at the record's commit. */
	"RELEASE_LANDING_UNJUDGED",
	/** Under release mode `none`, an ancestry nobody could read, so the record cannot be shown. */
	"RELEASE_LANDING_UNREAD",
	/** Under release mode `none`, a project whose source names no branch for work to land on. */
	"RELEASE_LANDING_NO_BRANCH",
	"RELEASE_BATCH_ABORTED",
	"RELEASE_FINISH_IN_FLIGHT",
	"RELEASE_FINISHED_FOR_OTHER_COMMIT",
	"RELEASE_CLAIM_LOST",
	"RELEASE_FINISH_LEASE_LOST",
	"RELEASE_VERSION_MISSING",
	"RELEASE_VERSION_CONFLICT",
	"RELEASE_VERSION_EXHAUSTED",
	"RELEASE_VERSION_LINE_BEHIND",
	"RELEASE_RUN_HOLDING",
	"RELEASE_RUN_NOT_OPEN",
	"RELEASE_NOTHING_RECORDED",
	"RELEASE_ALL_SHIPPED_EARLIER",
	"RELEASE_ALL_DESIGN_ONLY",
	"RELEASE_CARRIED_CONTRADICTS",
	"RELEASE_CARRIED_SHAPE",
	"RELEASE_CARRIED_RUN_OPEN",
	"RELEASE_CARRIED_SHIPPED",
	/** A range report for a release that has no release shipped before it to start from. */
	"RELEASE_RANGE_NO_BASE",
	/** A range report starting anywhere but the commit the release shipped before it served. */
	"RELEASE_RANGE_BASE_MOVED",
	/** A range report that names a file the reader reads and does not send it. */
	"RELEASE_RANGE_FILE_MISSING",
	/** A range report that sends a file the reader does not read, or one its changes do not name. */
	"RELEASE_RANGE_FILE_UNREAD",
	/** A name or summary written for a version that is neither the drafted release nor one cut. */
	"RELEASE_VERSION_UNKNOWN",
	/** A change-request release's declared order that is not exactly its roster's change requests. */
	"RELEASE_CHANGE_REQUEST_ORDER",
] as const;
export type ReleaseRefusalCode = (typeof RELEASE_REFUSAL_CODES)[number];
export const RELEASE_REFUSAL_STATUSES = {
	RELEASE_CLAIM_LOST: 409,
	RELEASE_FINISH_LEASE_LOST: 409,
	RELEASE_VERSION_CONFLICT: 409,
	RELEASE_VERSION_UNDECIDED: 409,
	RELEASE_CARRIED_RUN_OPEN: 409,
	RELEASE_CARRIED_SHIPPED: 409,
	CLAIM_CONFLICT: 409,
	RELEASE_RANGE_NO_BASE: 409,
	RELEASE_RANGE_BASE_MOVED: 409,
	RELEASE_VERSION_UNKNOWN: 404,
} as const satisfies RefusalStatuses<ReleaseRefusalCode | ReleaseBlockerCode>;

/** What production serves, read when asked and never stored (core `release-batch/serving-reading.ts`). */
export interface ServedAt {
	readonly commit: string;
	readonly where: string;
}

/** One reading. `served` pairs each commit a probe or a Forge deployment answered with where it
 *  runs — a probe's url, a target's deployment — `unread` is a line per source answering none, and
 *  only a project with nothing to ask is an absence: `missing` says why, `route` what opens one. */
export type ServingReading =
	| {
			readonly kind: "serving";
			readonly served: readonly ServedAt[];
			readonly unread: readonly string[];
			readonly readAt: string;
	  }
	| {
			readonly kind: "undeclared";
			readonly missing: string;
			readonly route: string;
	  }
	| {
			readonly kind: "unreadable";
			readonly why: string;
			readonly hosts: readonly string[];
			readonly readAt: string;
	  };

export function servedCommits(serving: ServingReading): string[] {
	if (serving.kind !== "serving") return [];
	return [...new Set(serving.served.map((s) => s.commit))];
}

/** `release.approval.required` of a project document; a project with no document, or no release rule, requires none. */
export function releaseApprovalRequired(
	document:
		| { release?: { approval: { required: boolean } } | undefined }
		| null
		| undefined,
): boolean {
	return document?.release?.approval.required === true;
}

/**
 * `release.changeRequests` of a project document (REQ-63 BC-1): its release is merging the
 * change requests its roster ships, in the order the cut declares, after an approval and with no
 * deploy. Read only beside `release.approval.required` and no production environment, which the
 * project document's rules require of it.
 */
export function releaseThroughChangeRequests(
	document:
		| { release?: { changeRequests?: boolean | undefined } | undefined }
		| null
		| undefined,
): boolean {
	return document?.release?.changeRequests === true;
}

/** Where a change request stands on its host, as the projection last read it. */
export const CHANGE_REQUEST_STATES = ["open", "closed", "merged"] as const;
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

/**
 * The change request that delivers an issue (REQ-63 BC-4, BC-5): a GitHub pull request `#n` or a
 * GitLab merge request `!n`, linked to every issue its branch or description names.
 */
export interface ReleaseChangeRequest {
	/** As its host writes it: `!12` for a merge request, `#12` for a pull request. */
	label: string;
	number: number;
	title: string;
	url: string | null;
	state: ChangeRequestState;
	/** Its place in the release's declared merge order, 1-based; null outside a change-request release. */
	order: number | null;
}

/** How many issues one release batch carries at most. */
export const RELEASE_ROSTER_LIMIT = 50;

/** A release runtime path's own spelling, as a prefix that owns the files under it (ISS-1368). */
export function runtimePathPrefix(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}
