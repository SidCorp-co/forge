import { useQuery } from "@tanstack/react-query";
import { useActiveOrg } from "@/features/orgs";
import { attentionApi } from "./api";

/**
 * Cross-project attention/inbox view: `/me/attention` as core's one attention read model serves it,
 * scoped to the active org, with the offline runners, each bucket's count and the total. The screen
 * renders those; it counts, merges and filters nothing. Keyed under `["attention"]` so the WS
 * invalidations refetch it. It waits for the active org to resolve: sent before, it went once unscoped
 * and again scoped, two of core's slowest reads on every route (ISS-1070).
 */
export function useAttention() {
  const { activeOrgId, resolved } = useActiveOrg();
  const attentionQ = useQuery({
    queryKey: ["attention", activeOrgId],
    queryFn: () => attentionApi.list(activeOrgId),
    enabled: resolved,
  });
  const view = attentionQ.data;
  return {
    view,
    total: view?.total ?? 0,
    /** Core's decisions-across-projects figure, in every project whatever the active org: what the Attention tab and the Overview badge carry (REQ-48 r3 BC-17). */
    waitingOnYou: view?.waitingOnYou ?? 0,
    /** Whether core has answered, so a badge never reads 0 for "not read yet". */
    known: view !== undefined,
    /** Reading, the wait for the org included, so a screen never draws "unread" in that gap. */
    isLoading: attentionQ.isLoading || !resolved,
    isError: attentionQ.isError,
    error: attentionQ.error,
    refetch: () => {
      void attentionQ.refetch();
    },
  };
}
