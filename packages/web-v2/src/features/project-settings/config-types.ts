export type V1Document = Record<string, unknown>;

export type V1Read =
	| { declared: false; revision: null; document: null }
	| {
			declared: true;
			revision: number;
			document: V1Document;
			updatedBy?: string;
			updatedAt?: string;
	  };

export type V1Written = Extract<V1Read, { declared: true }> & { created: boolean };

export interface V1Write {
	baseRevision: number | null;
	document: V1Document;
}

interface TestingProfileRow extends Extract<V1Read, { declared: true }> {
	profileId: string;
}

export interface TestingProfileList {
	profiles: TestingProfileRow[];
	returned: number;
}

export interface SecretName {
	ref: string;
	scope: string;
	name: string;
	updatedAt: string;
}

export interface SecretNameList {
	secrets: SecretName[];
	returned: number;
}

export interface BindingList {
	bindings: Extract<V1Read, { declared: true }>[];
	unrepresentable: { id: string; provider: string; role: string; revision: number; reason: string }[];
	returned: number;
}

export type EffectiveLayer = "project" | "policy" | "testing-profile" | "device-binding" | "binding";

export interface EffectiveValue {
	value: unknown;
	from: EffectiveLayer;
	revision?: number;
}

export type EffectiveConfig =
	| { declared: false; revision: null }
	| {
			declared: true;
			revision: number;
			device: string | null;
			undeclared: EffectiveLayer[];
			values: Record<string, EffectiveValue>;
	  };

type ProbeWhere = { url: string; identifies: "source" | "artifact" };

export type ProbeOutcome =
	| (ProbeWhere & { status: "confirmed"; observed: string })
	| (ProbeWhere & { status: "mismatch"; observed: string; expected: string })
	| (ProbeWhere & { status: "uncompared"; observed: string; error: string })
	| (ProbeWhere & { status: "unreachable"; error: string });

export type EnvironmentState =
	| {
			environment: string;
			state: "unknown";
			evidence: "none";
			reason: {
				cause: "external" | "no-record" | "adapter-error" | "binding-refused";
				message: string;
			};
	  }
	| {
			environment: string;
			state: "deployed" | "deploying" | "failed" | "cancelled";
			evidence:
				| "runtime-confirmed"
				| "runtime-mismatch"
				| "runtime-unreachable"
				| "deployment-record";
			deployment: {
				id: string;
				provider: string;
				status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
				at: string;
			};
			release?: { id: string } | null;
			artifact: { kind: "container-image" | "theme" | "bundle"; id: string } | null;
			source:
				| { kind: "revision"; revision: string }
				| { kind: "unrecorded" }
				| { kind: "non-git" };
			probes?: ProbeOutcome[];
	  };

export interface EnvironmentStateList {
	revision: number;
	environments: EnvironmentState[];
}
