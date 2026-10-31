// How tightly Forge gates a project's agents (REQ-76): one profile per project, strict, standard or
// yolo, and a mode per policy gate on top of it. The catalog below names every policy gate, what it
// refuses and its mode in each profile (BC-1). The kernel is not in it: what no profile relaxes is
// `KERNEL_RULES`, and an override naming one is refused at the schema (BC-10).
//
// A gate's mode resolves in one order, the answer carrying where it came from:
// 1. `gates.overrides.<gate>` where the project set one (BC-3);
// 2. the profile's default; under `standard` a gate that already had its own switch reads that
//    switch (`approvals.admit`, `plan.approval.required`, `validation.mergeCheck`, `policy.qa`, ...),
//    so a project with no `gates` keeps every switch it set (BC-2). `standard` otherwise acts first
//    (REQ-79 r6, owner ruling 2026-10-31): a builder verdict, a design record, a pattern review and a
//    scope hold are `strict`'s, the human control a project asks for, and never hold an agent by default.
// A profile Forge raised after an incident (BC-13) is an ordinary profile with `raised` beside it;
// only a person lowers it again.
//
// Modes, after Kubernetes Pod Security Admission's enforce/warn and Sentinel's hard-mandatory and
// advisory levels: `enforce` refuses, `advise` lets the act through and records the gap on it,
// `off` asks nothing. A gate declares the modes it can take: a person gate either asks the approve
// permission or does not, so it has no advise.

import { z } from "zod";
import { verdictsRequiredOf } from "./delivery-policy.js";

export const GATE_PROFILES = ["strict", "standard", "yolo"] as const;
export type GateProfile = (typeof GATE_PROFILES)[number];

/** Tightest first: a raise moves a project to the left, never past `standard` on its own. */
export const PROFILE_TIGHTNESS: Readonly<Record<GateProfile, number>> = {
	strict: 2,
	standard: 1,
	yolo: 0,
};

export const GATE_MODES = ["enforce", "advise", "off"] as const;
export type GateMode = (typeof GATE_MODES)[number];

/** A profile's default for a gate: a mode, or the gate's own switch in the project's config. */
export type GateDefault = GateMode | { readonly key: string };

export interface GateEntry {
	readonly id: string;
	readonly title: string;
	/** What the gate refuses, as its refusal reads to the person or agent it stops. */
	readonly refuses: string;
	/** The refusal codes it answers with where it is enforced. */
	readonly codes: readonly string[];
	/** Where it is asked: the machine and step a reader finds it at. */
	readonly at: string;
	readonly modes: readonly GateMode[];
	readonly defaults: Readonly<Record<GateProfile, GateDefault>>;
	/** What `advise` and `off` let through, in a sentence. */
	readonly relaxed: string;
}

const KEYED = (key: string): GateDefault => ({ key });
const ENFORCE_OFF = ["enforce", "off"] as const;
const ALL_MODES = GATE_MODES;
const CHECKLIST_MODES = ["enforce", "advise"] as const;

function defineGates<const G extends readonly GateEntry[]>(gates: G): G {
	const seen = new Set<string>();
	for (const g of gates) {
		if (seen.has(g.id)) throw new Error(`gate \`${g.id}\` is declared twice`);
		seen.add(g.id);
		for (const profile of GATE_PROFILES) {
			const d = g.defaults[profile];
			if (typeof d === "string" && !g.modes.includes(d)) {
				throw new Error(`gate \`${g.id}\`: its ${profile} default \`${d}\` is not one of its modes`);
			}
		}
	}
	return gates;
}

export const GATE_CATALOG = defineGates([
	{
		id: "issue_ready",
		title: "Issue-ready checklist",
		refuses: "an issue opening without an agreed requirement, criteria traced to its BCs, or the design revision it builds",
		codes: ["CHECKLIST_INCOMPLETE"],
		at: "issue draft → open",
		modes: CHECKLIST_MODES,
		defaults: { strict: "enforce", standard: "enforce", yolo: "advise" },
		relaxed: "advise opens it anyway, each gap recorded on the move as waived",
	},
	{
		id: "link_requirement_agreed",
		title: "Linked requirement agreed",
		refuses: "linking an issue to a requirement that is not agreed",
		codes: ["REQUIREMENT_NOT_AGREED"],
		at: "issue ↔ requirement link",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "enforce", yolo: "off" },
		relaxed: "off links a requirement still in draft",
	},
	{
		id: "approval_admit",
		title: "A person admits issues",
		refuses: "opening an issue, or promoting a requirement's draft issues, without issues.admit",
		codes: ["PERMISSION_FORBIDDEN"],
		at: "issue draft → open; promote drafts",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("approvals.admit"), yolo: "off" },
		relaxed: "off lets any project writer open it",
	},
	{
		id: "plan_approval",
		title: "Plan approval",
		refuses: "moving an issue to approved without plans.approve, or its work into build before it passed approved since its plan was last written; the plan checkpoint is asked at all only where this is enforced",
		codes: ["PERMISSION_FORBIDDEN", "PLAN_APPROVAL_PENDING"],
		at: "issue in_progress → approved, work step design → build",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("plan.approval.required"), yolo: "off" },
		relaxed: "off: the run's own plan checkpoint is enough",
	},
	{
		id: "design_record",
		title: "Design record",
		refuses: "building without a recorded design (criterion classes, patterns, proof and scope), or without a plan written against the requirement the issue delivers",
		codes: ["DESIGN_RECORD_MISSING", "DESIGN_RECORD_INCOMPLETE", "PLAN_REQUIRED"],
		at: "issue in_progress → approved, work step design → build",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "off", yolo: "off" },
		relaxed: "off: build starts with no design record or plan",
	},
	{
		id: "design_approved_for_build",
		title: "Design approved before build",
		refuses: "taking an issue whose design revision is not approved",
		codes: ["WORKFLOW_DESIGN_NOT_APPROVED"],
		at: "issue take",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "enforce", yolo: "off" },
		relaxed: "off: the issue is taken while its design waits",
	},
	{
		id: "scope_hold",
		title: "Scope held by another run",
		refuses: "a second run taking or building a scope another live run holds",
		codes: ["ISSUE_SCOPE_HELD"],
		at: "issue take, work step build",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "off", yolo: "off" },
		relaxed: "off: both runs work the scope; the overlap is theirs to merge",
	},
	{
		id: "patterns",
		title: "Pattern review",
		refuses: "taking or merging an issue whose new pattern is unreviewed, returned or not catalogued",
		codes: ["PATTERN_REVIEW_PENDING", "PATTERN_RETURNED", "PATTERN_ENTRY_MISSING"],
		at: "issue take; issue in_progress → awaiting_release",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "off", yolo: "off" },
		relaxed: "off: a new pattern lands unreviewed",
	},
	{
		id: "contract_wait",
		title: "Contract waits settled",
		refuses: "taking an issue that waits on another project's contract version",
		codes: ["CONTRACT_WAIT_UNSETTLED"],
		at: "issue take",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "enforce", yolo: "off" },
		relaxed: "off: the issue is taken before the contract it waits on settles",
	},
	{
		id: "take_blocked",
		title: "Blocks edges",
		refuses: "taking an issue another unsettled issue blocks",
		codes: ["ISSUE_BLOCKED"],
		at: "issue take",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "enforce", yolo: "enforce" },
		relaxed: "off: a blocks edge orders nothing. Every profile enforces it: an edge is somebody's own ordering, not a default",
	},
	{
		id: "merge_check",
		title: "Merge check recorded",
		refuses: "marking a merge with no passing merge check at the commit",
		codes: ["MERGE_CHECK_MISSING"],
		at: "issue merge mark",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("validation.mergeCheck"), yolo: "off" },
		relaxed: "off: a merge is marked without a recorded check",
	},
	{
		id: "merge_review",
		title: "Merge review recorded",
		refuses: "marking a merge with no recorded review",
		codes: ["MERGE_REVIEW_MISSING"],
		at: "issue merge mark",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("validation.mergeCheck"), yolo: "off" },
		relaxed: "off: a merge is marked without a recorded review",
	},
	{
		id: "builder_verdict",
		title: "The builder does not judge its own work",
		refuses: "counting a pass the run that built the change recorded",
		codes: ["VERDICT_BY_BUILDER"],
		at: "criterion verdicts, release and acceptance",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "off", yolo: "off" },
		relaxed: "off: the builder's own pass counts",
	},
	{
		id: "independent_qa",
		title: "Independent judge",
		refuses: "counting a pass with no author named",
		codes: [],
		at: "criterion verdicts, release and acceptance",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("policy.qa"), yolo: "off" },
		relaxed: "off: an unauthored pass counts, as under qa self",
	},
	{
		id: "intake",
		title: "Manual intake",
		refuses: "a master taking open work no person started",
		codes: ["INTAKE_NOT_MANUAL"],
		at: "admissible issues",
		modes: ENFORCE_OFF,
		defaults: { strict: KEYED("policy.intake.mode"), standard: KEYED("policy.intake.mode"), yolo: "off" },
		relaxed: "off: masters take open work by themselves, as under intake auto",
	},
	{
		id: "approval_agree",
		title: "A person agrees requirements",
		refuses: "agreeing a requirement without requirements.approve",
		codes: ["PERMISSION_FORBIDDEN"],
		at: "requirement draft → agreed",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("approvals.agree"), yolo: "off" },
		relaxed: "off: any project writer agrees it",
	},
	{
		id: "approval_revisions",
		title: "A person approves revisions",
		refuses: "making a requirement revision current without requirements.approve",
		codes: ["PERMISSION_FORBIDDEN"],
		at: "requirement revision → current",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("approvals.revisions"), yolo: "off" },
		relaxed: "off: any project writer accepts the revision",
	},
	{
		id: "approval_breakdown",
		title: "A person accepts breakdowns",
		refuses: "accepting a breakdown without suggestions.approve",
		codes: ["PERMISSION_FORBIDDEN"],
		at: "requirement breakdown",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("approvals.breakdown"), yolo: "off" },
		relaxed: "off: the master's own accept files the issues",
	},
	{
		id: "approval_accept",
		title: "A person accepts deliveries",
		refuses: "accepting a delivered requirement without requirements.approve",
		codes: ["PERMISSION_FORBIDDEN"],
		at: "requirement delivered → accepted",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("approvals.accept"), yolo: "off" },
		relaxed: "off: any project writer accepts it",
	},
	{
		id: "approval_designs",
		title: "A person approves designs",
		refuses: "approving a workflow design without workflow-designs.approve",
		codes: ["PERMISSION_FORBIDDEN"],
		at: "workflow design decision",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("approvals.designs"), yolo: "off" },
		relaxed: "off: a holder of workflow-designs.write approves",
	},
	{
		id: "requirement_ready",
		title: "Requirement-ready checklist",
		refuses: "agreeing a requirement, or accepting its revision, with a blocking question unanswered",
		codes: ["CHECKLIST_INCOMPLETE"],
		at: "requirement draft → agreed; revision → current",
		modes: CHECKLIST_MODES,
		defaults: { strict: "enforce", standard: "enforce", yolo: "advise" },
		relaxed: "advise moves it on, each gap recorded as waived",
	},
	{
		id: "requirement_acceptance",
		title: "Acceptance checklist",
		refuses: "accepting a delivered requirement with a criterion unproven",
		codes: ["CHECKLIST_INCOMPLETE"],
		at: "requirement delivered → accepted",
		modes: CHECKLIST_MODES,
		defaults: { strict: "enforce", standard: "enforce", yolo: "advise" },
		relaxed: "advise accepts it, each gap recorded as waived",
	},
	{
		id: "breakdown",
		title: "Breakdown checklist",
		refuses: "accepting a breakdown that leaves a BC untraced or an issue without criteria",
		codes: ["CHECKLIST_INCOMPLETE"],
		at: "requirement breakdown",
		modes: CHECKLIST_MODES,
		defaults: { strict: "enforce", standard: "enforce", yolo: "advise" },
		relaxed: "advise accepts it, each gap recorded as waived",
	},
	{
		id: "workflow_approval",
		title: "Workflow approval checklist",
		refuses: "approving a design with a checklist answer missing",
		codes: ["CHECKLIST_INCOMPLETE"],
		at: "workflow design decision",
		modes: CHECKLIST_MODES,
		defaults: { strict: "enforce", standard: "enforce", yolo: "advise" },
		relaxed: "advise approves it, each gap recorded as waived",
	},
	{
		id: "feedback_triage",
		title: "Feedback triage checklist",
		refuses: "triaging feedback with a checklist answer missing",
		codes: ["CHECKLIST_INCOMPLETE"],
		at: "feedback triage",
		modes: ["enforce"],
		defaults: { strict: "enforce", standard: "enforce", yolo: "enforce" },
		relaxed: "never relaxed: a triage's answers are where the item goes (its route), so a triage with a gap would route it nowhere",
	},
	{
		id: "release_approval",
		title: "A person approves releases",
		refuses: "a release reaching production with no approval",
		codes: ["RELEASE_APPROVAL_REQUIRED", "RELEASE_AWAITING_APPROVAL"],
		at: "release attempt",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: KEYED("release.approval.required"), yolo: "off" },
		relaxed: "off: a release ships with nobody approving",
	},
	{
		id: "release_criteria",
		title: "Criteria proven before release",
		refuses: "a release carrying an issue whose criteria have no counted pass",
		codes: ["RELEASE_CRITERIA_UNEARNED"],
		at: "release roster",
		modes: ALL_MODES,
		defaults: { strict: "enforce", standard: KEYED("delivery.verdictsRequired"), yolo: "advise" },
		relaxed: "advise ships it, naming each unproven criterion as a warning; off asks no verdict",
	},
	{
		id: "chat_files_issue",
		title: "Chat files feedback, not issues",
		refuses: "a chat or direct request filing an issue",
		codes: ["CHAT_FILES_FEEDBACK_NOT_ISSUES"],
		at: "issue create from chat",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "enforce", yolo: "off" },
		relaxed: "off: a chat files the issue itself, through the same ready check",
	},
	{
		id: "master_admitted_only",
		title: "Masters wait for admitted work",
		refuses: "placing a master for a chat or direct request while no admitted work waits",
		codes: ["nothing_owed"],
		at: "master placement",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "enforce", yolo: "off" },
		relaxed: "off: a master is placed for a waiting chat or direct request too",
	},
	{
		id: "issue_before_code",
		title: "An issue before the code",
		refuses: "recording a merge that names no issue",
		codes: [],
		at: "a merge on the base branch",
		modes: ENFORCE_OFF,
		defaults: { strict: "enforce", standard: "enforce", yolo: "off" },
		relaxed: "off: a merge naming no issue files its issue and records its landing from the merge",
	},
] as const);

export type GateId = (typeof GATE_CATALOG)[number]["id"];
export const GATE_IDS = GATE_CATALOG.map((g) => g.id) as readonly GateId[];

export const gateEntry = (id: GateId): GateEntry => {
	const entry = GATE_CATALOG.find((g) => g.id === id);
	if (!entry) throw new Error(`gate \`${id}\` is not in the catalog`);
	return entry;
};

export const isGateId = (id: string): id is GateId => (GATE_IDS as readonly string[]).includes(id);

/** What no profile, override or raise relaxes (BC-10, VISION kernel-hard-policy-soft). */
export const KERNEL_RULES = [
	{ id: "transition_evidence", holds: "no status move without its evidence: a legal edge, its reason, its waiting kind", codes: ["ILLEGAL_TRANSITION", "TRANSITION_REASON_REQUIRED", "WAITING_KIND_REQUIRED"] },
	{ id: "merged", holds: "no awaiting_release without a recorded merge", codes: ["MERGE_NOT_RECORDED", "MERGE_DESIGN_ONLY"] },
	{ id: "close_by_release", holds: "no close without a release that claimed the issue and its recorded merge", codes: ["CLOSE_ONLY_BY_RELEASE", "CLOSE_REQUIRES_SHIPPED", "DESIGN_NOT_DELIVERED"] },
	{ id: "run_holder", holds: "only the holding run, or releases.approve, moves an issue to in_progress or awaiting_release", codes: ["NOT_THE_HOLDER", "NO_HOLDER"] },
	{ id: "review_by_builder", holds: "a recorded review is never the builder's own", codes: ["REVIEW_BY_BUILDER"] },
	{ id: "verdict_shape", holds: "a verdict names a known criterion and carries no secret", codes: ["VERDICT_CRITERION_UNKNOWN", "VERDICT_SECRET"] },
	{ id: "requirement_proven", holds: "a requirement reads delivered only where every BC is proven", codes: ["REQUIREMENT_CRITERIA_UNPROVEN", "REQUIREMENT_NO_LIVE_ISSUE"] },
	{ id: "declared_gate", holds: "no release puts a commit on production while the project's declared validation gate check is red, pending, silent or unread there", codes: ["RELEASE_GATE_CHECK_RED", "RELEASE_GATE_CHECK_PENDING", "RELEASE_GATE_CHECK_SILENT", "RELEASE_GATE_CHECK_UNREAD"] },
	{ id: "pat_fence", holds: "a fenced token reaches only its own project", codes: ["PAT_PROJECT_OUTSIDE_FENCE", "PAT_ACCOUNT_ROUTE"] },
] as const;

/** What a write to a project's gates answers with. */
export const GATE_PROFILE_REFUSAL_CODES = [
	"GATES_REASON_REQUIRED",
	"GATE_UNKNOWN",
	"GATE_MODE_UNSUPPORTED",
	"GATES_NO_PROJECT_DOCUMENT",
	"GATE_PROFILE_RAISED",
	"GATES_WRITTEN_THROUGH_THEIR_DOOR",
] as const;

export const RAISE_CAUSES = ["deploy_failed", "release_reverted"] as const;
export type RaiseCause = (typeof RAISE_CAUSES)[number];

const LIMITS = { ref: 200 } as const;

/** The project document's `gates`. */
export const gatesConfigSchema = z.strictObject({
	profile: z.enum(GATE_PROFILES),
	overrides: z
		.strictObject(
			Object.fromEntries(GATE_IDS.map((id) => [id, z.enum(GATE_MODES).optional()])) as Record<
				GateId,
				z.ZodOptional<z.ZodEnum<{ [M in GateMode]: M }>>
			>,
		)
		.optional(),
	/** Set by Forge alone when an incident raised the profile; a person's lowering clears it. */
	raised: z
		.strictObject({
			from: z.enum(GATE_PROFILES),
			cause: z.enum(RAISE_CAUSES),
			ref: z.string().min(1).max(LIMITS.ref),
			at: z.iso.datetime(),
		})
		.optional(),
});
export type GatesConfig = z.infer<typeof gatesConfigSchema>;

/** A gate's mode on one project, with where it came from and the key that sets it. */
export interface ResolvedGate {
	readonly id: GateId;
	readonly mode: GateMode;
	readonly profile: GateProfile;
	/** `override`: gates.overrides; `profile`: the profile's default; `key`: the gate's own switch. */
	readonly from: "override" | "profile" | "key";
	/** The config key that decided it. */
	readonly key: string;
}

export const gateProfileOf = (gates: GatesConfig | null | undefined): GateProfile =>
	gates?.profile ?? "standard";

/**
 * The mode `id` takes under `gates`; `keyMode` is what the gate's own switch says, read by the caller
 * from the project's documents, used only where the profile defers to it.
 */
export function resolveGate(
	gates: GatesConfig | null | undefined,
	id: GateId,
	keyMode: GateMode,
): ResolvedGate {
	const profile = gateProfileOf(gates);
	const overridden = gates?.overrides?.[id];
	if (overridden) return { id, mode: overridden, profile, from: "override", key: `gates.overrides.${id}` };
	const d = gateEntry(id).defaults[profile];
	if (typeof d === "string") return { id, mode: d, profile, from: "profile", key: "gates.profile" };
	return { id, mode: keyMode, profile, from: "key", key: d.key };
}

/** The sentence a refusal by `g` ends with (BC-11): the gate, the profile and what relaxes it. */
export function gateSays(g: ResolvedGate): string {
	const by =
		g.from === "override"
			? `this project's override ${g.key}`
			: g.from === "key"
				? `this project's ${g.key} setting, which its gate profile ${g.profile} defers to`
				: `this project's gate profile ${g.profile} (gates.profile)`;
	// plain words: it ends refusals a person reads, a checklist gap's among them; a setting the profile
	// defers to is the nearer way to relax it, so it is named before the override
	const relaxes = g.from === "key" ? `changing ${g.key}, or gates.overrides.${g.id},` : `gates.overrides.${g.id}`;
	return `Gate ${g.id} is ${g.mode === "enforce" ? "enforced" : g.mode} by ${by}; ${relaxes} relaxes it.`;
}

/** What of a project document a gate's own switch reads: the keys the profile defers to under standard. */
export interface GateSwitches {
	readonly approvals?: Readonly<Partial<Record<string, boolean | undefined>>> | null | undefined;
	readonly plan?: { readonly approval?: { readonly required: boolean } | undefined } | null | undefined;
	readonly validation?: { readonly mergeCheck?: "required" | undefined } | null | undefined;
	readonly release?: { readonly approval?: { readonly required: boolean } | undefined } | null | undefined;
	readonly delivery?: { readonly verdictsRequired?: boolean | undefined } | null | undefined;
	readonly gates?: GatesConfig | null | undefined;
}

/** What of the policy document a gate's own switch reads; absent, the default policy's. */
export interface PolicySwitches {
	readonly qa?: "self" | "independent" | undefined;
	readonly intake?: { readonly mode: "auto" | "manual" } | undefined;
}

const on = (b: boolean): GateMode => (b ? "enforce" : "off");

/** What the gate's own switch says, for the gates whose standard default defers to one. */
function switchMode(doc: GateSwitches | null | undefined, policy: PolicySwitches | null | undefined, id: GateId): GateMode {
	switch (id) {
		case "approval_admit":
		case "approval_agree":
		case "approval_revisions":
		case "approval_breakdown":
		case "approval_accept":
		case "approval_designs":
			return on(doc?.approvals?.[id.slice("approval_".length)] === true);
		case "plan_approval":
			return on(doc?.plan?.approval?.required === true);
		case "merge_check":
		case "merge_review":
			return on(doc?.validation?.mergeCheck === "required");
		case "independent_qa":
			return on(policy?.qa === "independent");
		case "intake":
			return on(policy?.intake?.mode === "manual");
		case "release_approval":
			return on(doc?.release?.approval?.required === true);
		case "release_criteria":
			return on(verdictsRequiredOf(doc?.delivery));
		default:
			return "enforce";
	}
}

/** The mode of gate `id` on a project, read from its project document and policy. */
export function projectGate(
	doc: GateSwitches | null | undefined,
	policy: PolicySwitches | null | undefined,
	id: GateId,
): ResolvedGate {
	return resolveGate(doc?.gates, id, switchMode(doc, policy, id));
}

/** Every gate's mode on a project, in catalog order. */
export function projectGates(
	doc: GateSwitches | null | undefined,
	policy: PolicySwitches | null | undefined,
): ResolvedGate[] {
	return GATE_IDS.map((id) => projectGate(doc, policy, id));
}

export const gateEnforced = (g: ResolvedGate): boolean => g.mode === "enforce";
