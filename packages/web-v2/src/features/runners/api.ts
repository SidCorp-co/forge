// web-v2 feature module: runners / devices — REST surface. Every call goes
// through the shared `apiClient` (no raw fetch). Reconciles ISS-296 (runner
// detail / quota / exclude-include) with ISS-305 (browser-approve device login).
// Routes verified against `packages/core/src/devices/{routes,login-routes}.ts`
// + `packages/core/src/runners/routes.ts`.
import { apiClient } from "@/lib/api/client";
import type { MyDevice, PairingCode, RefreshQuotaResult, RunnerDetail } from "./types";

export const runnersApi = {
  /** `GET /api/me/devices` — the caller's paired devices. */
  listMyDevices: () => apiClient<MyDevice[]>("/me/devices"),

  /** `GET /api/runners?projectId=` — full runner rows for one project (model
   *  via `type`, quota via `config.quota`, `deviceId` for grouping). Omitting
   *  `projectId` returns an empty list server-side, so it is REQUIRED. */
  listProjectRunners: (projectId: string) =>
    apiClient<{ runners: RunnerDetail[] }>(
      `/runners?projectId=${encodeURIComponent(projectId)}`,
    ),

  /** `POST /api/runners/:id/refresh-quota` — re-pull the adapter Claude quota. */
  refreshQuota: (runnerId: string) =>
    apiClient<RefreshQuotaResult>(`/runners/${runnerId}/refresh-quota`, { method: "POST" }),

  /** `POST /api/runners/:id/exclude` — disable a runner (status → disabled). */
  excludeRunner: (runnerId: string) =>
    apiClient<{ ok: true }>(`/runners/${runnerId}/exclude`, { method: "POST" }),

  /** `POST /api/runners/:id/include` — re-enable a runner (status → offline). */
  includeRunner: (runnerId: string) =>
    apiClient<{ ok: true }>(`/runners/${runnerId}/include`, { method: "POST" }),

  /** `PATCH /api/devices/:id` — rename a device. */
  renameDevice: (id: string, name: string) =>
    apiClient<MyDevice>(`/devices/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  /** `DELETE /api/devices/:id` — revoke a device (requires fresh auth). */
  revokeDevice: (id: string) => apiClient<void>(`/devices/${id}`, { method: "DELETE" }),

  /**
   * `POST /api/devices/login/init` (ISS-305) — mint a pairing code for the
   * browser-approve device-login flow (like `claude login`). `device_platform`
   * defaults to linux (the common runner host); it only labels the device row
   * created at approval time.
   */
  initPairing: (deviceLabel: string, platform: "macos" | "linux" | "windows" = "linux") =>
    apiClient<PairingCode>(`/devices/login/init`, {
      method: "POST",
      body: JSON.stringify({ device_label: deviceLabel, device_platform: platform }),
    }),
};
