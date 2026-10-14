import type { AgentAccess, BindingRole, ConnectionBindingItem } from "@forge/contracts/integrations";
import { formatApiError } from "@/lib/api/error";
import { configApi } from "@/features/project-config";
import { documentRefusals, refusalLine } from "@/lib/api/refusals";
import { integrationConnectionsApi, integrationsApi } from "./api";
import {
	type BindingDocument,
	type BindingRead,
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

const readBinding = async (projectId: string, id: string) =>
	(await configApi.getBinding(projectId, id)) as BindingRead;

/** The item one project takes in a bind call: the binding-v1 target and grant, nothing else. */
function itemFor(projectId: string, input: Omit<BindConnectionInput, "connectionId">): ConnectionBindingItem {
	return {
		projectId,
		role: input.role,
		target: targetOf(input.provider, input.binding, input.label ?? ""),
		...(input.agentAccess ? { agentAccess: input.agentAccess } : {}),
	};
}

/** Bind an existing connection into one project, through the same one-call bind as several. */
export async function bindConnection(projectId: string, input: BindConnectionInput) {
	return integrationConnectionsApi.bind(input.connectionId, [itemFor(projectId, input)]);
}

/** Bind an existing connection into several projects, each with its own target, as one write. */
export async function bindConnectionInto(connectionId: string, items: ConnectionBindingItem[]) {
	return integrationConnectionsApi.bind(connectionId, items);
}

/**
 * Create a connection and bind it into `projectId` and every project of `alsoProjectIds`, all with
 * the same target, in one call: core writes all of it or none of it (FB-128).
 */
export async function createIntegration(
	projectId: string,
	input: CreateIntegrationInput,
	alsoProjectIds: readonly string[] = [],
) {
	const tiers = splitTiers(input.provider, input.config);
	const bound = { ...input, binding: tiers.binding };
	return integrationConnectionsApi.create({
		provider: input.provider as never,
		config: tiers.connection,
		secrets: input.secrets ?? {},
		...(input.orgId ? { orgId: input.orgId } : {}),
		bindings: [projectId, ...alsoProjectIds.filter((id) => id !== projectId)].map((id) => itemFor(id, bound)),
	});
}

function withInstructions(document: BindingDocument, instructions: string | null | undefined): BindingDocument {
	if (instructions === undefined) return document;
	const { instructions: _replaced, ...rest } = document;
	return instructions ? { ...rest, instructions } : rest;
}

export async function updateIntegration(projectId: string, id: string, input: UpdateIntegrationInput) {
	const { items } = await integrationsApi.list(projectId);
	const summary = items.find((b) => b.id === id);
	if (!summary) throw new Error(`binding ${id} is not one of this project's`);
	const tiers = splitTiers(summary.provider, input.config ?? {});
	const rebinds =
		Object.keys(tiers.binding).length > 0 ||
		input.agentAccess !== undefined ||
		input.active !== undefined ||
		input.instructions !== undefined;

	if (rebinds) {
		const read = await readBinding(projectId, id);
		if (!read.declared) throw new Error(`binding ${id} has no binding document to edit`);
		const base = read.document;
		const merged = mergeBindingConfig(bindingConfigOf(base.target), tiers.binding);
		await configApi.putBinding(projectId, id, {
			baseRevision: read.revision,
			document: withInstructions(
				{
					...base,
					agentAccess: input.agentAccess ?? base.agentAccess ?? "none",
					active: input.active ?? base.active ?? true,
					target: targetOf(summary.provider, merged, summary.label),
				},
				input.instructions,
			),
		});
	}

	const connectionConfig = Object.keys(tiers.connection).length > 0 ? tiers.connection : undefined;
	if (connectionConfig || input.secrets) {
		return integrationsApi.update(projectId, id, {
			...(connectionConfig ? { config: connectionConfig } : {}),
			...(input.secrets ? { secrets: input.secrets } : {}),
		});
	}
	return null;
}

export function bindingRefusalText(err: unknown): string {
	const refusals = documentRefusals(err);
	if (refusals.length === 0) return formatApiError(err);
	return refusals.map(refusalLine).join(" · ");
}
