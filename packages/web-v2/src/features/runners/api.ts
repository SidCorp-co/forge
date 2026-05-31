// web-v2 feature module: runners/devices — REST surface. All calls go through
// the shared `apiClient`. Routes verified against
// `packages/core/src/devices/{routes,login-routes}.ts`.
import { apiClient } from "@/lib/api/client";
import type { DeviceRow, DeviceRunnerAssignment, PairingCode } from "./types";

export const runnersApi = {
  /** `GET /api/me/devices` — the caller's paired devices. */
  listDevices: () => apiClient<DeviceRow[]>(`/me/devices`),

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
    apiClient<void>(`/projects/${projectId}/runners/${runnerId}`, { method: "DELETE" }),

  /** `DELETE /api/devices/:id` — soft-revoke a device (requires fresh auth). */
  revokeDevice: (id: string) =>
    apiClient<void>(`/devices/${id}`, { method: "DELETE" }),

  /**
   * `POST /api/devices/login/init` — mint a pairing code for the browser-approve
   * device-login flow. `device_platform` defaults to linux (the common runner
   * host); the value only affects the device row created at approval time.
   */
  initPairing: (deviceLabel: string, platform: "macos" | "linux" | "windows" = "linux") =>
    apiClient<PairingCode>(`/devices/login/init`, {
      method: "POST",
      body: JSON.stringify({ device_label: deviceLabel, device_platform: platform }),
    }),
};
