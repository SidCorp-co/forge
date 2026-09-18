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
  /**
   * Approve a pending device-login code. With `agentUserId`, the box is paired as
   * that AGENT and the credential it receives belongs to the agent, not to the
   * approver; without it, the box is the approver's as before.
   */
  // cm:guard `agent_id` is OMITTED and never sent as null when nobody picked an agent. The route reads `undefined | null` alike today, but an absent key is the one shape that cannot be read as "pair as agent null"; sending the key always is how a picker that failed to load would start deciding an identity (ISS-1093 criterion 32).
  approve: (pairingCode: string, agentUserId?: string | null) =>
    apiClient<{ approved: boolean; device: ApprovedDevice }>(`/devices/login/approve`, {
      method: "POST",
      body: JSON.stringify({
        pairing_code: pairingCode,
        ...(agentUserId ? { agent_id: agentUserId } : {}),
      }),
    }),
};
