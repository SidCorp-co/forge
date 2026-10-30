// A project's environment variables (REQ-80): the reads and writes the Variables section makes. A
// secret's value is fetched only by an explicit reveal, never cached with the list.
import type {
	CreateVariableRequest,
	DecideVariableProposalRequest,
	UpdateVariableRequest,
	VariableEventView,
	VariableProposalView,
	VariableView,
} from "@forge/contracts/variables";
import { useQuery } from "@tanstack/react-query";
import { useToastedMutation } from "@/features/project-config";
import { apiClient } from "@/lib/api/client";
import { useCopy } from "@/lib/i18n/interface-language";

export interface VariablesRead {
	variables: VariableView[];
	environments: { name: string; tier: string }[];
	canManage: boolean;
	proposalsWaiting: number;
}

const base = (id: string) => `/projects/${id}/variables`;

export const variablesApi = {
	list: (id: string) => apiClient<VariablesRead>(base(id)),
	create: (id: string, body: CreateVariableRequest) =>
		apiClient<VariableView>(base(id), { method: "POST", body: JSON.stringify(body) }),
	update: (id: string, variable: string, body: UpdateVariableRequest) =>
		apiClient<VariableView>(`${base(id)}/${variable}`, { method: "PUT", body: JSON.stringify(body) }),
	remove: (id: string, variable: string, baseVersion: number) =>
		apiClient<{ deleted: string }>(`${base(id)}/${variable}?baseVersion=${baseVersion}`, { method: "DELETE" }),
	reveal: (id: string, variable: string) =>
		apiClient<{ id: string; key: string; value: string }>(`${base(id)}/${variable}/reveal`, { method: "POST" }),
	events: (id: string) => apiClient<{ events: VariableEventView[] }>(`${base(id)}/events`),
	proposals: (id: string) => apiClient<{ proposals: VariableProposalView[] }>(`${base(id)}/proposals`),
	decide: (id: string, proposal: string, body: DecideVariableProposalRequest) =>
		apiClient<VariableProposalView>(`${base(id)}/proposals/${proposal}/decision`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
};

const keys = {
	all: (id: string) => ["project", id, "variables"] as const,
	events: (id: string) => ["project", id, "variables", "events"] as const,
	proposals: (id: string) => ["project", id, "variables", "proposals"] as const,
};

export const useVariables = (id: string) => useQuery({ queryKey: keys.all(id), queryFn: () => variablesApi.list(id) });
export const useVariableEvents = (id: string, enabled: boolean) =>
	useQuery({ queryKey: keys.events(id), queryFn: () => variablesApi.events(id), enabled });
export const useVariableProposals = (id: string) =>
	useQuery({ queryKey: keys.proposals(id), queryFn: () => variablesApi.proposals(id) });

export function useCreateVariable(id: string) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (body: CreateVariableRequest) => variablesApi.create(id, body),
		invalidates: [keys.all(id)],
		saved: (v) => t("settings.project.variables.added", { key: v.key }),
		failed: t("settings.project.variables.writeFailed"),
	});
}

export function useUpdateVariable(id: string) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (w: { variable: string; body: UpdateVariableRequest }) => variablesApi.update(id, w.variable, w.body),
		invalidates: [keys.all(id)],
		saved: (v) => t("settings.project.variables.saved", { key: v.key }),
		failed: t("settings.project.variables.writeFailed"),
	});
}

export function useDeleteVariable(id: string) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (v: { variable: string; baseVersion: number }) => variablesApi.remove(id, v.variable, v.baseVersion),
		invalidates: [keys.all(id)],
		saved: t("settings.project.variables.deleted"),
		failed: t("settings.project.variables.writeFailed"),
	});
}

export function useDecideProposal(id: string) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (d: { proposal: string; body: DecideVariableProposalRequest }) => variablesApi.decide(id, d.proposal, d.body),
		invalidates: [keys.all(id), keys.proposals(id)],
		saved: (p) => t(p.status === "approved" ? "settings.project.variables.approved" : "settings.project.variables.rejected", { key: p.key }),
		failed: t("settings.project.variables.writeFailed"),
	});
}
