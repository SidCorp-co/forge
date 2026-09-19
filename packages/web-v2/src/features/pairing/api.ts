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
  approve: (pairingCode: string, agentUserId?: string | null) =>
    apiClient<{ approved: boolean; device: ApprovedDevice }>(`/devices/login/approve`, {
      method: "POST",
      body: JSON.stringify({
        pairing_code: pairingCode,
        ...(agentUserId ? { agent_id: agentUserId } : {}),
      }),
    }),
};
