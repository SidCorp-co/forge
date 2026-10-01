import type { AgentAccess, BindingRole } from "@forge/contracts";
import { providerModule } from "./providers/registry";

const RELEASE_RUNNER_LABEL = "releaseRunnerLabel";

export const BINDING_SCHEMA = "https://forge.sidcorp.co/schemas/binding-v1.json";

export interface BindingDocument {
	$schema: string;
	version: 1;
	id: string;
	role: BindingRole;
	connection: string;
	agentAccess?: AgentAccess;
	target: Record<string, unknown> & { provider: string; label?: string };
}

export type BindingRead =
	| { declared: false; revision: null; document: null }
	| { declared: true; revision: number; document: BindingDocument };

function bindingKeysOf(provider: string): readonly string[] {
	const module = providerModule(provider);
	if (!module) throw new Error(`no provider module for "${provider}", so its binding tier is unknown`);
	return [...module.bindingKeys, RELEASE_RUNNER_LABEL];
}

function withoutNulls(config: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== null && v !== undefined));
}

export function splitTiers(
	provider: string,
	config: Record<string, unknown>,
): { connection: Record<string, unknown>; binding: Record<string, unknown> } {
	const keys = bindingKeysOf(provider);
	const connection: Record<string, unknown> = {};
	const binding: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (keys.includes(key)) binding[key] = value;
		else connection[key] = value;
	}
	return { connection, binding };
}

export function targetOf(
	provider: string,
	bindingConfig: Record<string, unknown>,
	label: string,
): BindingDocument["target"] {
	const config = withoutNulls(bindingConfig);
	const runnerLabel = config[RELEASE_RUNNER_LABEL];
	const tier = Object.fromEntries(
		bindingKeysOf(provider)
			.filter((k) => k !== RELEASE_RUNNER_LABEL && config[k] !== undefined)
			.map((k) => [k, config[k]]),
	);
	const shaped = providerModule(provider)?.bindingTarget?.toTarget(tier) ?? tier;
	return {
		provider,
		...shaped,
		...(label ? { label } : {}),
		...(typeof runnerLabel === "string" && runnerLabel !== "" ? { releaseRunnerLabel: runnerLabel } : {}),
	};
}

export function bindingConfigOf(target: BindingDocument["target"]): Record<string, unknown> {
	const { provider, label: _label, releaseRunnerLabel, ...fields } = target;
	const tier = providerModule(provider)?.bindingTarget?.toConfig(fields) ?? fields;
	return releaseRunnerLabel === undefined ? tier : { ...tier, [RELEASE_RUNNER_LABEL]: releaseRunnerLabel };
}

export function mergeBindingConfig(
	current: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	return withoutNulls({ ...current, ...patch });
}
