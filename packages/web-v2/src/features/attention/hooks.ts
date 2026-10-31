import { useQuery } from "@tanstack/react-query";
import { useActiveOrg } from "@/features/orgs";
import { attentionApi } from "./api";

/**
 * Cross-project attention/inbox view: `/me/attention` as core's one attention read model serves it,
 * scoped to the active org, with the offline runners, each bucket's count and the total. The screen
 * renders those; it counts, merges and filters nothing. Keyed under `["attention"]` so the WS
 * invalidations refetch it.
 */
export function useAttention() {
  const { activeOrgId } = useActiveOrg();
  const attentionQ = useQuery({
    queryKey: ["attention", activeOrgId],
    queryFn: () => attentionApi.list(activeOrgId),
  });
  const view = attentionQ.data;
  return {
    view,
    total: view?.total ?? 0,
    /** Core's decisions-across-projects figure, in every project whatever the active org: what the Attention tab and the Overview badge carry (REQ-48 r3 BC-17). */
    waitingOnYou: view?.waitingOnYou ?? 0,
    /** Whether core has answered, so a badge never reads 0 for "not read yet". */
    known: view !== undefined,
    isLoading: attentionQ.isLoading,
    isError: attentionQ.isError,
    error: attentionQ.error,
    refetch: () => {
      void attentionQ.refetch();
    },
  };
}
