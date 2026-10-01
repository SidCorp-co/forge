import type { AgentAccess, BindingRole } from "@forge/contracts";
import { refusalsOf } from "@/features/project-settings/document-edit";
import { formatApiError } from "@/lib/api/error";
import { integrationConnectionsApi, integrationsApi } from "./api";
import {
	BINDING_SCHEMA,
	type BindingDocument,
	bindingConfigOf,
	mergeBindingConfig,
	splitTiers,
	targetOf,
} from "./binding-document";

export interface CreateIntegrationInput {
	provider: string;
	role: BindingRole;
	config: Record<string, unknown>;
	secrets?: Record<string, unknown>;
	orgId?: string;
	label?: string;
	agentAccess?: AgentAccess;
}

export interface BindConnectionInput {
	connectionId: string;
	provider: string;
	role: BindingRole;
	binding: Record<string, unknown>;
	label?: string;
	agentAccess?: AgentAccess;
}

export interface UpdateIntegrationInput {
	config?: Record<string, unknown>;
	secrets?: Record<string, unknown>;
	active?: boolean;
	instructions?: string | null;
	agentAccess?: AgentAccess;
}

export async function bindConnection(projectId: string, input: BindConnectionInput) {
	const label = input.label ?? "";
	const { items } = await integrationsApi.list(projectId);
	const freed = items.find(
		(b) =>
			b.provider === input.provider &&
			b.label === label &&
			b.role === "service" &&
			input.role === "service" &&
			!b.bindingActive,
	);
	const id = freed?.id ?? crypto.randomUUID();
	const document: BindingDocument = {
		$schema: BINDING_SCHEMA,
		version: 1,
		id,
		role: input.role,
		connection: input.connectionId,
		agentAccess: input.agentAccess ?? "none",
		target: targetOf(input.provider, input.binding, label),
	};
	return integrationsApi.putBindingDocument(projectId, id, { baseRevision: null, document });
}

export async function createIntegration(projectId: string, input: CreateIntegrationInput) {
	const tiers = splitTiers(input.provider, input.config);
	const created = await integrationConnectionsApi.create({
		provider: input.provider as never,
		config: tiers.connection,
		secrets: input.secrets ?? {},
		...(input.orgId ? { orgId: input.orgId } : {}),
	});
	try {
		return await bindConnection(projectId, {
			connectionId: created.connection.id,
			provider: input.provider,
			role: input.role,
			binding: tiers.binding,
			...(input.label ? { label: input.label } : {}),
			...(input.agentAccess ? { agentAccess: input.agentAccess } : {}),
		});
	} catch (err) {
		await integrationConnectionsApi.remove(created.connection.id).catch(() => undefined);
		throw err;
	}
}

export async function updateIntegration(projectId: string, id: string, input: UpdateIntegrationInput) {
	const { items } = await integrationsApi.list(projectId);
	const summary = items.find((b) => b.id === id);
	if (!summary) throw new Error(`binding ${id} is not one of this project's`);
	const tiers = splitTiers(summary.provider, input.config ?? {});
	const rebinds = Object.keys(tiers.binding).length > 0 || input.agentAccess !== undefined;

	if (rebinds) {
		const read = summary.bindingActive ? await integrationsApi.bindingDocument(projectId, id) : null;
		const base: BindingDocument =
			read?.declared === true
				? read.document
				: {
						$schema: BINDING_SCHEMA,
						version: 1,
						id,
						role: summary.role,
						connection: summary.connectionId,
						agentAccess: summary.agentAccess,
						target: targetOf(summary.provider, summary.bindingConfig, summary.label),
					};
		const merged = mergeBindingConfig(bindingConfigOf(base.target), tiers.binding);
		await integrationsApi.putBindingDocument(projectId, id, {
			baseRevision: read?.declared === true ? read.revision : null,
			document: {
				...base,
				agentAccess: input.agentAccess ?? base.agentAccess ?? "none",
				target: targetOf(summary.provider, merged, summary.label),
			},
		});
	}

	const connectionConfig = Object.keys(tiers.connection).length > 0 ? tiers.connection : undefined;
	const active = rebinds && input.active === true ? undefined : input.active;
	if (connectionConfig || input.secrets || active !== undefined || input.instructions !== undefined) {
		return integrationsApi.update(projectId, id, {
			...(connectionConfig ? { config: connectionConfig } : {}),
			...(input.secrets ? { secrets: input.secrets } : {}),
			...(active === undefined ? {} : { active }),
			...(input.instructions === undefined ? {} : { instructions: input.instructions }),
		});
	}
	return null;
}

export function bindingRefusalText(err: unknown): string {
	const refusals = refusalsOf(err);
	if (refusals.length === 0) return formatApiError(err);
	return refusals.map((r) => `${r.code} at ${r.path || "/"}: ${r.detail}`).join(" · ");
}
