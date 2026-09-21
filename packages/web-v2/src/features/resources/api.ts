import { apiClient } from "@/lib/api/client";
import type { SshConnTestResult, SshKeyCreateInput, WorkspaceSshKeyView } from "./types";

export const resourcesApi = {
	/** `GET /api/orgs/:orgId/ssh-keys` — the org's pool (non-secret + usedBy). */
	listSshKeys: (orgId: string) =>
		apiClient<WorkspaceSshKeyView[]>(`/orgs/${orgId}/ssh-keys`),

	createSshKey: (orgId: string, body: SshKeyCreateInput) =>
		apiClient<WorkspaceSshKeyView>(`/orgs/${orgId}/ssh-keys`, {
			method: "POST",
			body: JSON.stringify(body),
		}),

	/** `DELETE /api/orgs/:orgId/ssh-keys/:keyId` — safe-delete (409 if in use). */
	deleteSshKey: (orgId: string, keyId: string) =>
		apiClient<void>(`/orgs/${orgId}/ssh-keys/${keyId}`, { method: "DELETE" }),

	testSshKey: (orgId: string, keyId: string, repoUrl: string) =>
		apiClient<SshConnTestResult>(`/orgs/${orgId}/ssh-keys/${keyId}/test`, {
			method: "POST",
			body: JSON.stringify({ repoUrl }),
		}),
};
