// web-v2 feature module: runners / devices. Types are re-typed to match the
// EXACT JSON returned by core (timestamps are ISO strings over the wire, not
// `Date`). Verified for ISS-296 against:
//   • `packages/core/src/devices/routes.ts`  (GET /api/me/devices, pairing-codes)
//   • `packages/core/src/runners/routes.ts`  (GET /api/runners, refresh-quota)
// Do NOT invent fields — the device card derives `model`/`quota`/activity from
// the real runner row below (there is no top-level `model`/`currentJob` column).
import type { HealthKey } from "@/design";

export type DevicePlatform = "macos" | "linux" | "windows";
export type DeviceStatus = "online" | "offline" | "revoked";
export type RunnerStatus = "online" | "offline" | "draining" | "disabled";
export type RunnerType = "claude-code" | "antigravity";

/** Curated subset of the `devices` row from `GET /api/me/devices` (sensitive
 *  token columns are stripped server-side). */
export interface MyDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  agentVersion: string | null;
  status: DeviceStatus;
  lastSeenAt: string | null;
  pairedAt: string;
  capabilities: Record<string, unknown>;
  createdAt: string;
}

/** Claude (or adapter) quota, persisted under `runners.config.quota` and
 *  refreshed via `POST /api/runners/:id/refresh-quota`. */
export interface RunnerQuota {
  remaining: number | null;
  limit: number | null;
  refreshedAt?: string;
}

/** A `runners` row from `GET /api/runners?projectId=`. Carries `deviceId` (so
 *  we can group runners under their device card), `repoPath`/`branch` (the
 *  per-device×project checkout), and `config.quota` for the Claude quota Stat. */
export interface RunnerDetail {
  id: string;
  projectId: string;
  type: RunnerType;
  host: "device" | "remote";
  deviceId: string | null;
  name: string;
  labels: string[];
  capabilities: Record<string, unknown>;
  config: Record<string, unknown> & { quota?: RunnerQuota };
  status: RunnerStatus;
  lastSeenAt: string | null;
  lastError: string | null;
  repoPath?: string | null;
  branch?: string | null;
}

/** `POST /api/runners/:id/refresh-quota` response. */
export interface RefreshQuotaResult {
  remaining: number | null;
  limit: number | null;
  details?: Record<string, unknown>;
}

/** `POST /api/projects/:id/devices/pairing-codes` response. */
export interface PairingCode {
  code: string;
  expiresAt: string;
}

/** Map a device status to a design-kit health key for the HealthDot. */
export function deviceHealth(status: DeviceStatus): HealthKey {
  switch (status) {
    case "online":
      return "healthy";
    case "offline":
      return "down";
    default:
      return "idle"; // revoked
  }
}

/** Map a runner status to a health key. `draining` = finishing work (busy). */
export function runnerHealth(status: RunnerStatus): HealthKey {
  switch (status) {
    case "online":
      return "healthy";
    case "draining":
      return "attention";
    case "offline":
      return "down";
    default:
      return "idle"; // disabled
  }
}

/** Human label for a runner's status (the closest signal to "current job" the
 *  REST surface exposes — there is no per-runner job column). */
export function runnerActivity(r: RunnerDetail): string {
  switch (r.status) {
    case "online":
      return "Ready";
    case "draining":
      return "Finishing work…";
    case "offline":
      return "Disconnected";
    case "disabled":
      return "Excluded";
    default:
      return r.status;
  }
}

/** Display "model" for a runner. The row has no `model` column — surface the
 *  adapter `type` plus any capability labels the agent advertised. */
export function runnerModel(r: RunnerDetail): string {
  return r.type === "claude-code" ? "claude-code" : r.type;
}

/** Whether a device or any of its runners is offline (drives ReconnectingBanner). */
export function isDeviceOffline(device: MyDevice, runners: RunnerDetail[]): boolean {
  if (device.status === "offline") return true;
  return runners.some((r) => r.status === "offline");
}
