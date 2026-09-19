
import { apiClient } from "@/lib/api/client";
import type {
	ActiveRunnersSnapshot,
	DeviceRow,
	DeviceRunnerAssignment,
	PairingCode,
	ProjectGitAccessView,
	ProjectRunner,
	RunnerActivity,
	SshConnTestResult,
} from "./types";

export const runnersApi = {
	listDevices: (orgId?: string) =>
		apiClient<DeviceRow[]>(orgId ? `/me/devices?orgId=${encodeURIComponent(orgId)}` : `/me/devices`),

	/** `PATCH /api/devices/:id` — rename a device (owner only). */
	renameDevice: (id: string, name: string) =>
		apiClient<DeviceRow>(`/devices/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		}),

	/**
	 * `GET /api/devices/:id/runners` — the project pools (runner bindings) this
	 * device serves, with each runner's per-device repo path/branch + status.
	 */
	listDeviceRunners: (deviceId: string) =>
		apiClient<DeviceRunnerAssignment[]>(`/devices/${deviceId}/runners`),

	bindRunner: (projectId: string, deviceId: string, repoPath: string | null) =>
		apiClient<{ id: string }>(`/projects/${projectId}/runners`, {
			method: "POST",
			body: JSON.stringify({ deviceId, repoPath }),
		}),

	/** `PATCH /api/projects/:projectId/runners/:runnerId` — per-device repo path/branch, or the pool labels. */
	patchRunner: (
		projectId: string,
		runnerId: string,
		body: {
			repoPath?: string | null;
			branch?: string | null;
			labels?: string[];
		},
	) =>
		apiClient<{ id: string }>(`/projects/${projectId}/runners/${runnerId}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),

	clearRunnerError: (projectId: string, runnerId: string) =>
		apiClient<{ runnerId: string; cleared: boolean }>(
			`/projects/${projectId}/runners/${runnerId}/clear-error`,
			{ method: "POST" },
		),

	unbindRunner: (projectId: string, runnerId: string) =>
		apiClient<void>(`/projects/${projectId}/runners/${runnerId}`, {
			method: "DELETE",
		}),

	setDeviceDisabled: (id: string, disabled: boolean) =>
		apiClient<DeviceRow>(`/devices/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ disabled }),
		}),

	/** `DELETE /api/devices/:id` — soft-revoke a device (requires fresh auth). */
	revokeDevice: (id: string) =>
		apiClient<void>(`/devices/${id}`, { method: "DELETE" }),

	initPairing: (
		deviceLabel: string,
		platform: "macos" | "linux" | "windows" = "linux",
	) =>
		apiClient<PairingCode>(`/devices/login/init`, {
			method: "POST",
			body: JSON.stringify({
				device_label: deviceLabel,
				device_platform: platform,
			}),
		}),

	
	/** `GET /api/projects/:id/runners` — the device pools serving THIS project. */
	listProjectRunners: (projectId: string) =>
		apiClient<ProjectRunner[]>(`/projects/${projectId}/runners`),

	listActiveRunners: (projectId: string) =>
		apiClient<ActiveRunnersSnapshot>(
			`/runners/active?projectId=${encodeURIComponent(projectId)}`,
		),

	/**
	 * `GET /api/runners/:id/activity` — per-runner status timeline + recent
	 * device sessions (with error excerpts). Read-only; any project member.
	 */
	getRunnerActivity: (runnerId: string, limit = 15) =>
		apiClient<RunnerActivity>(`/runners/${runnerId}/activity?limit=${limit}`),

	patchRunnerStatus: (
		runnerId: string,
		status: "online" | "offline" | "draining" | "disabled",
	) =>
		apiClient<{ runner: { id: string; status: string } }>(
			`/runners/${runnerId}`,
			{ method: "PATCH", body: JSON.stringify({ status }) },
		),

	/** `GET /api/projects/:id/git-credential` — resolved org-pool key reference. */
	getGitCredential: (projectId: string) =>
		apiClient<ProjectGitAccessView>(`/projects/${projectId}/git-credential`),

	/**
	 * `PUT /api/projects/:id/git-credential` — pick a key from the project's org
	 * pool. Server rejects a key from a different org (400 `WRONG_ORG`).
	 */
	setGitCredential: (projectId: string, sshKeyId: string) =>
		apiClient<ProjectGitAccessView>(`/projects/${projectId}/git-credential`, {
			method: "PUT",
			body: JSON.stringify({ sshKeyId }),
		}),

	/**
	 * `POST /api/projects/:id/git-credential/test` — probe the referenced pool
	 * key against the project's SSH repo URL (git ls-remote). Non-mutating.
	 */
	testGitCredential: (projectId: string) =>
		apiClient<SshConnTestResult>(
			`/projects/${projectId}/git-credential/test`,
			{ method: "POST" },
		),

	/** `DELETE /api/projects/:id/git-credential` — remove the deploy key. */
	deleteGitCredential: (projectId: string) =>
		apiClient<void>(`/projects/${projectId}/git-credential`, {
			method: "DELETE",
		}),

	/**
	 * `PATCH /api/projects/:id` — set the project's primary (default) device.
	 * `null` clears it. Dispatch prefers this device first, then standby runners.
	 * Org owner/admin only (server-gated).
	 */
	setDefaultDevice: (projectId: string, deviceId: string | null) =>
		apiClient<{ id: string }>(`/projects/${projectId}`, {
			method: "PATCH",
			body: JSON.stringify({ defaultDeviceId: deviceId }),
		}),
};
