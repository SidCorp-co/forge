import { apiClient } from "@/lib/api/client";
import type {
	BindingList,
	EffectiveConfig,
	EnvironmentStateList,
	SecretName,
	SecretNameList,
	TestingProfileList,
	V1Read,
	V1Write,
	V1Written,
} from "./config-types";

const put = (path: string, write: V1Write) =>
	apiClient<V1Written>(path, { method: "PUT", body: JSON.stringify(write) });

export const configApi = {
	getProjectDocument: (id: string) => apiClient<V1Read>(`/projects/${id}/config`),

	putProjectDocument: (id: string, write: V1Write) => put(`/projects/${id}/config`, write),

	getPolicy: (id: string) => apiClient<V1Read>(`/projects/${id}/policy`),

	putPolicy: (id: string, write: V1Write) => put(`/projects/${id}/policy`, write),

	listTestingProfiles: (id: string) =>
		apiClient<TestingProfileList>(`/projects/${id}/testing-profiles`),

	putTestingProfile: (id: string, profileId: string, write: V1Write) =>
		put(`/projects/${id}/testing-profiles/${encodeURIComponent(profileId)}`, write),

	deleteTestingProfile: (id: string, profileId: string) =>
		apiClient<{ deleted: true; profileId: string }>(
			`/projects/${id}/testing-profiles/${encodeURIComponent(profileId)}`,
			{ method: "DELETE" },
		),

	listSecretNames: (id: string) => apiClient<SecretNameList>(`/projects/${id}/secrets`),

	putSecret: (id: string, scope: string, name: string, value: string) =>
		apiClient<SecretName>(
			`/projects/${id}/secrets/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`,
			{ method: "PUT", body: JSON.stringify({ value }) },
		),

	listBindings: (id: string) => apiClient<BindingList>(`/projects/${id}/bindings`),

	getBinding: (id: string, bindingId: string) =>
		apiClient<V1Read>(`/projects/${id}/bindings/${encodeURIComponent(bindingId)}`),

	putBinding: (id: string, bindingId: string, write: V1Write) =>
		put(`/projects/${id}/bindings/${encodeURIComponent(bindingId)}`, write),

	getEffective: (id: string) => apiClient<EffectiveConfig>(`/projects/${id}/config/effective`),

	getEnvironmentState: (id: string) =>
		apiClient<EnvironmentStateList>(`/projects/${id}/environments/state`),
};
