
import { useMutation } from "@tanstack/react-query";
import { useAgentAccounts } from "@/features/agent-accounts";
import { useActiveOrg } from "@/features/orgs";
import { isOrgAdmin } from "@/features/projects";
import { useAuth } from "@/providers/auth-provider";
import { pairingApi } from "./api";

/** Approve a pending device-login pairing code, optionally as an agent. */
export function useApproveDevice() {
  return useMutation({
    mutationFn: (args: { pairingCode: string; agentUserId?: string | null }) =>
      pairingApi.approve(args.pairingCode, args.agentUserId),
  });
}

/** Who a box may be paired as: the signed-in person, and the agents of the active org when they administer it. */
export function usePairIdentities() {
  const { user } = useAuth();
  const { activeOrg } = useActiveOrg();
  const orgAdmin = isOrgAdmin(activeOrg?.role);
  const agentsQ = useAgentAccounts(orgAdmin ? (activeOrg?.id ?? null) : null);
  return { user, activeOrg, orgAdmin, agentsQ };
}
