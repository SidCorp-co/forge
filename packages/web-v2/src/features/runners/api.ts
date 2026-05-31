// web-v2 feature module: runners/devices — REST surface. All calls go through
// the shared `apiClient`. Routes verified against
// `packages/core/src/devices/{routes,login-routes}.ts`.
import { apiClient } from "@/lib/api/client";
import type { DeviceRow, PairingCode } from "./types";

export const runnersApi = {
  /** `GET /api/me/devices` — the caller's paired devices. */
  listDevices: () => apiClient<DeviceRow[]>(`/me/devices`),

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
