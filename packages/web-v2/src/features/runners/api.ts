
import { apiClient } from "@/lib/api/client";
import type {
	ActiveRunnersSnapshot,
	DeviceRow,
	DeviceRunnerAssignment,
	OrgDeviceRow,
	ProjectRunner,
	RunnerActivity,
} from "./types";

export const runnersApi = {
	listDevices: (orgId?: string) =>
		apiClient<DeviceRow[]>(orgId ? `/me/devices?orgId=${encodeURIComponent(orgId)}` : `/me/devices`),

	/**
	 * `GET /api/orgs/:orgId/devices` — the organisation's devices over the
	 * projects this caller can see. A different population from `/me/devices`,
	 * whose `orgId` narrows the caller's own list rather than widening it.
	 */
	listOrgDevices: (orgId: string) =>
		apiClient<OrgDeviceRow[]>(`/orgs/${encodeURIComponent(orgId)}/devices`),

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

	/** `PATCH /api/projects/:projectId/runners/:runnerId` — the pool labels. */
	patchRunner: (projectId: string, runnerId: string, body: { labels: string[] }) =>
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

};
