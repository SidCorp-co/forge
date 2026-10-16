import { useMutation, useQuery } from "@tanstack/react-query";
import { reauthWithPassword } from "@/features/auth";
import { mcpAuthApi } from "./api";
import type { ConsentRequest } from "./consent-draft";

/** What the consent page asks about; a refusal is the page's answer, so it is not retried. */
export function useConsentView(request: ConsentRequest, enabled: boolean) {
  return useQuery({
    queryKey: ["mcp-auth", "consent", request],
    queryFn: () => mcpAuthApi.view(request),
    enabled,
    retry: false,
  });
}

/** Sends the decision, then the browser to where core says the client waits for it. */
export function useConsentDecision() {
  return useMutation({
    mutationFn: mcpAuthApi.decide,
    onSuccess: (answer) => window.location.assign(answer.redirectTo),
  });
}

export function usePasswordReauth() {
  return useMutation({ mutationFn: reauthWithPassword });
}
