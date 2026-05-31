// web-v2 feature module: pairing — the browser side of the runner
// browser-approve device-login flow (ISS-305). Routes verified against
// `packages/core/src/devices/login-routes.ts`.
import { apiClient } from "@/lib/api/client";

/** Device descriptor returned by `POST /api/devices/login/approve`. */
export interface ApprovedDevice {
  label: string;
  platform: string;
  hostname: string | null;
  created_ip: string | null;
  created_user_agent: string | null;
  created_at: string;
  expires_at: string;
}

export const pairingApi = {
  /** Approve a pending device-login code, binding it to the signed-in user. */
  approve: (pairingCode: string) =>
    apiClient<{ approved: boolean; device: ApprovedDevice }>(`/devices/login/approve`, {
      method: "POST",
      body: JSON.stringify({ pairing_code: pairingCode }),
    }),
};
