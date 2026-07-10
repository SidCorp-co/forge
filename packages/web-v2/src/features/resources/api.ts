// web-v2 feature module: workspace Resources → Private Keys — REST surface.
// Routes verified against `packages/core/src/orgs/ssh-keys-routes.ts`.
import { apiClient } from "@/lib/api/client";
import type { SshConnTestResult, SshKeyCreateInput, WorkspaceSshKeyView } from "./types";

export const resourcesApi = {
	/** `GET /api/orgs/:orgId/ssh-keys` — the org's pool (non-secret + usedBy). */
	listSshKeys: (orgId: string) =>
		apiClient<WorkspaceSshKeyView[]>(`/orgs/${orgId}/ssh-keys`),

	/**
	 * `POST /api/orgs/:orgId/ssh-keys` — `generate` mints a fresh ed25519 pair;
	 * `provide` stores a user-pasted private key. Returns the public half only.
	 */
	createSshKey: (orgId: string, body: SshKeyCreateInput) =>
		apiClient<WorkspaceSshKeyView>(`/orgs/${orgId}/ssh-keys`, {
			method: "POST",
			body: JSON.stringify(body),
		}),

	/** `DELETE /api/orgs/:orgId/ssh-keys/:keyId` — safe-delete (409 if in use). */
	deleteSshKey: (orgId: string, keyId: string) =>
		apiClient<void>(`/orgs/${orgId}/ssh-keys/${keyId}`, { method: "DELETE" }),

	/**
	 * `POST /api/orgs/:orgId/ssh-keys/:keyId/test` — probe the key against a
	 * caller-supplied repo URL (git ls-remote). Non-mutating.
	 */
	testSshKey: (orgId: string, keyId: string, repoUrl: string) =>
		apiClient<SshConnTestResult>(`/orgs/${orgId}/ssh-keys/${keyId}/test`, {
			method: "POST",
			body: JSON.stringify({ repoUrl }),
		}),
};
