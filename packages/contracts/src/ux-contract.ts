export type UxPreset = "app-strict" | "marketing" | "internal-tool" | "custom";

export type UxRuleGroup =
	| "designSystem"
	| "states"
	| "flows"
	| "a11y"
	| "microcopy"
	| "responsive";

export type UxRuleSeverity = "must" | "should";
export type UxRuleSource = "preset" | "detected" | "learned" | "manual";
export type UxRuleStatus = "active" | "proposed" | "retired";

export interface UxToggleSettings {
	emptySearchRequired: boolean;
	destructiveConfirm: boolean;
	a11yLevel: "basic" | "AA";
	mobileResponsive: boolean;
	optimisticUI: boolean;
}

export interface UxStackProfile {
	projectLabel: string;
	bindingScope: string;
	knownGaps: string[];
	ruleOverrides?: Record<string, string>;
	designSystem?: {
		ownLibrary?: boolean;
		libraryName?: string | null;
		importRoot?: string | null;
		tokenSource?: string | null;
		toastMechanism?: string | null;
		i18n?: boolean;
		breakpoints?: string | null;
		statePrimitives?: string[];
	};
}

export interface UxContractRule {
	id: string;
	projectId: string;
	group: UxRuleGroup;
	text: string;
	severity: UxRuleSeverity;
	source: UxRuleSource;
	status: UxRuleStatus;
	evidenceIssueIds: string[];
	orderIndex: number;
	createdAt: string;
	updatedAt: string;
}

export interface UxFinding {
	id: string;
	projectId: string;
	issueId: string;
	runId: string | null;
	stage: "review" | "verify-live";
	ruleId: string | null;
	kind:
		| "missing-state"
		| "a11y"
		| "microcopy"
		| "responsive"
		| "design-system"
		| "other";
	detail: string;
	severity: UxRuleSeverity;
	createdAt: string;
}

export interface ApplyUxPresetInput {
	preset: UxPreset;
	toggles?: UxToggleSettings;
	profile?: UxStackProfile;
}

export interface UxContractRulePatch {
	group?: UxRuleGroup;
	text?: string;
	severity?: UxRuleSeverity;
	source?: UxRuleSource;
	status?: UxRuleStatus;
	orderIndex?: number;
}
