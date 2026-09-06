// web-v2 feature module: runners/devices — REST surface, all of it through the
// shared `apiClient`. It spans THREE core route files, not one:
// `devices/{routes,login-routes}.ts` (pairing, device state),
// `projects/runners-routes.ts` (bind, repo path, labels) and
// `runners/routes.ts` (status, activity). Each fences a different credential
// and validates a different `.strict()` body, so a call verified against the
// wrong one of the three compiles, ships, and 400s.

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

	/**
	 * `POST /api/projects/:projectId/runners/:runnerId/clear-error` — operator
	 * reset of every recorded fault on a runner (last error, rate/usage/auth
	 * limit, quarantine), followed by a dispatch tick so queued jobs get another
	 * shot. `cleared: false` means the runner had nothing recorded. Admin only.
	 */
	clearRunnerError: (projectId: string, runnerId: string) =>
		apiClient<{ runnerId: string; cleared: boolean }>(
			`/projects/${projectId}/runners/${runnerId}/clear-error`,
			{ method: "POST" },
		),

	/** `DELETE /api/projects/:projectId/runners/:runnerId` — unassign a project pool (idempotent). */
	unbindRunner: (projectId: string, runnerId: string) =>
		apiClient<void>(`/projects/${projectId}/runners/${runnerId}`, {
			method: "DELETE",
		}),

	/**
	 * `PATCH /api/devices/:id { disabled }` — reversible "turn off" switch. A
	 * disabled device keeps its token + runner bindings and still heartbeats, but
	 * is ignored by dispatch + interactive chat across every project; `false`
	 * re-enables it. Distinct from revoke (which is permanent). Owner only.
	 */
	setDeviceDisabled: (id: string, disabled: boolean) =>
		apiClient<DeviceRow>(`/devices/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ disabled }),
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

	
	/** `GET /api/projects/:id/runners` — the device pools serving THIS project. */
	listProjectRunners: (projectId: string) =>
		apiClient<ProjectRunner[]>(`/projects/${projectId}/runners`),

	/**
	 * `GET /api/runners/active?projectId=` — live snapshot of which runners are
	 * executing a job right now (runner → issue → stage → started-at), or idle.
	 * Read-only; any project member.
	 */
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

	// cm:edge contract -> packages/core/src/runners/routes.ts — `runners.status` is writable ONLY here: this route hands it to `setRunnerStatus`, which audits the transition into `runner_events`. The project-scoped PATCH next to it takes repoPath/branch/labels under a `.strict()` schema that REJECTS `status` with a 400, so admission sent there fails for every credential (it did, silently behind a toast, until 2026-09-06). Session-only by design — a PAT gets 403 and cannot withdraw a box.
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
