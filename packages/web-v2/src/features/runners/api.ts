// web-v2 feature module: runners/devices — REST surface. All calls go through
// the shared `apiClient`. Routes verified against
// `packages/core/src/devices/{routes,login-routes}.ts`.
import { apiClient } from "@/lib/api/client";
import type {
	DeviceRow,
	DeviceRunnerAssignment,
	GitCredentialView,
	PairingCode,
	ProjectRunner,
	RunnerActivity,
} from "./types";

export const runnersApi = {
	/**
	 * `GET /api/me/devices` — the caller's paired devices. ISS-477: pass `orgId`
	 * to scope to devices bound (via a runner) to a project in that org; omit it
	 * for the full owner-scoped list (device-name resolution on sessions, etc.).
	 */
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

	/**
	 * `POST /api/projects/:projectId/runners` — bind this device as a runner for
	 * a project (assign a project pool). Idempotent upsert keyed on
	 * (project, device, 'claude-code').
	 */
	bindRunner: (projectId: string, deviceId: string, repoPath: string | null) =>
		apiClient<{ id: string }>(`/projects/${projectId}/runners`, {
			method: "POST",
			body: JSON.stringify({ deviceId, repoPath }),
		}),

	/** `PATCH /api/projects/:projectId/runners/:runnerId` — set per-device repo path/branch. */
	patchRunner: (
		projectId: string,
		runnerId: string,
		body: { repoPath: string | null; branch: string | null },
	) =>
		apiClient<{ id: string }>(`/projects/${projectId}/runners/${runnerId}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),

	/** `DELETE /api/projects/:projectId/runners/:runnerId` — unassign a project pool (idempotent). */
	unbindRunner: (projectId: string, runnerId: string) =>
		apiClient<void>(`/projects/${projectId}/runners/${runnerId}`, {
			method: "DELETE",
		}),

	/** `DELETE /api/devices/:id` — soft-revoke a device (requires fresh auth). */
	revokeDevice: (id: string) =>
		apiClient<void>(`/devices/${id}`, { method: "DELETE" }),

	/**
	 * `POST /api/devices/login/init` — mint a pairing code for the browser-approve
	 * device-login flow. `device_platform` defaults to linux (the common runner
	 * host); the value only affects the device row created at approval time.
	 */
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

	// === Project-centric (the project Runners screen) ===

	/** `GET /api/projects/:id/runners` — the device pools serving THIS project. */
	listProjectRunners: (projectId: string) =>
		apiClient<ProjectRunner[]>(`/projects/${projectId}/runners`),

	/**
	 * `GET /api/runners/:id/activity` — per-runner status timeline + recent
	 * device sessions (with error excerpts). Read-only; any project member.
	 */
	getRunnerActivity: (runnerId: string, limit = 15) =>
		apiClient<RunnerActivity>(`/runners/${runnerId}/activity?limit=${limit}`),

	/** `GET /api/projects/:id/git-credential` — non-secret deploy-key status. */
	getGitCredential: (projectId: string) =>
		apiClient<GitCredentialView>(`/projects/${projectId}/git-credential`),

	/**
	 * `POST /api/projects/:id/git-credential` — `generate` mints an ed25519 pair;
	 * `provide` stores a user-pasted private key. Returns the public half only.
	 */
	setGitCredential: (
		projectId: string,
		body: { mode: "generate" } | { mode: "provide"; privateKey: string },
	) =>
		apiClient<GitCredentialView>(`/projects/${projectId}/git-credential`, {
			method: "POST",
			body: JSON.stringify(body),
		}),

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
