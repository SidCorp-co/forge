// web-v2 feature module: runners/devices. Types verified against
// `packages/core/src/devices/routes.ts` (GET /me/devices) and
// `packages/core/src/devices/login-routes.ts` (POST /devices/login/init).
import type { HealthKey } from "@/design";

/** A row of `GET /api/me/devices` (owner-scoped). */
export interface DeviceRow {
	id: string;
	name: string;
	platform: "macos" | "linux" | "windows";
	agentVersion: string | null;
	/** Latest published runner version (server-read VERSION), null if none. */
	latestAgentVersion: string | null;
	/** True when this device's agentVersion lags `latestAgentVersion` (ISS-392). */
	agentOutdated: boolean;
	status: "online" | "offline" | "revoked";
	lastSeenAt: string | null;
	pairedAt: string | null;
	capabilities: unknown;
	/** Non-secret label set when a git push credential was provisioned (ISS-305). */
	gitCredentialRef: string | null;
	createdAt: string;
}

/** `POST /api/devices/login/init` response — a fresh pairing code + verify URL. */
export interface PairingCode {
	pairing_code: string;
	/** Relative verify URL, e.g. `/pair?code=XXX-XXXX`. */
	verify_url: string;
	expires_at: string;
}

/**
 * One row of `GET /api/devices/:id/runners` (owner-scoped) — a (device ×
 * project) runner assignment. `repoPath`/`branch` are this device's per-project
 * checkout; `projectDefaultRepoPath`/`baseBranch` are the project defaults the
 * UI prefills from. Verified against `packages/core/src/devices/routes.ts`.
 */
export interface DeviceRunnerAssignment {
	runnerId: string;
	projectId: string;
	slug: string;
	name: string;
	repoPath: string | null;
	branch: string | null;
	status: string;
	lastSeenAt: string | null;
	projectDefaultRepoPath: string | null;
	baseBranch: string | null;
}

/**
 * Per (device × project) workspace provisioning lifecycle — mirrors core's
 * `runnerProvisionStatuses`. NULL/absent = legacy/not-yet-provisioned.
 */
export type ProvisionStatus =
	| "queued"
	| "cloning"
	| "syncing_skills"
	| "writing_mcp"
	| "ready"
	| "needs_manual_setup"
	| "failed";

/** One row of `GET /api/projects/:id/runners` (project-centric, member-scoped). */
export interface ProjectRunner {
	runnerId: string;
	deviceId: string | null;
	deviceName: string | null;
	platform: "macos" | "linux" | "windows" | null;
	deviceStatus: "online" | "offline" | "revoked" | null;
	runnerStatus: string;
	repoPath: string | null;
	branch: string | null;
	lastSeenAt: string | null;
	provisionStatus: ProvisionStatus | null;
	provisionDetail: string | null;
	provisionedAt: string | null;
}

/** `GET /api/projects/:id/git-credential` — non-secret deploy-key status. */
export type GitCredentialView =
	| { configured: false }
	| {
			configured: true;
			source: "forge_generated" | "user_provided";
			publicKey: string;
			fingerprint: string | null;
			createdAt: string;
	  };

/** Ordered provision steps for rendering a stepper. */
export const PROVISION_STEPS: ProvisionStatus[] = [
	"queued",
	"cloning",
	"syncing_skills",
	"writing_mcp",
	"ready",
];

/** Human label per provision status. */
export const PROVISION_LABEL: Record<ProvisionStatus, string> = {
	queued: "Queued",
	cloning: "Cloning repo",
	syncing_skills: "Syncing skills",
	writing_mcp: "Writing MCP config",
	ready: "Ready",
	needs_manual_setup: "Needs manual setup",
	failed: "Failed",
};

/** Map a provision status to a kit health key for dots/badges. */
export function provisionHealth(status: ProvisionStatus | null): HealthKey {
	switch (status) {
		case "ready":
			return "healthy";
		case "failed":
			return "down";
		case "needs_manual_setup":
			return "attention";
		case null:
			return "idle";
		default:
			return "idle";
	}
}

/** Map a device's online/offline/revoked status to a kit health key. */
export function deviceHealth(status: DeviceRow["status"]): HealthKey {
	switch (status) {
		case "online":
			return "healthy";
		case "revoked":
			return "down";
		default:
			return "idle";
	}
}

/** Map a runner's free-form status string to a kit health key. */
export function runnerHealth(status: string): HealthKey {
	switch (status) {
		case "online":
			return "healthy";
		case "revoked":
		case "disabled":
			return "down";
		default:
			return "idle";
	}
}
