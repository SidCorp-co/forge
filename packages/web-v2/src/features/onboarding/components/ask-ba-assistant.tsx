"use client";

// The BA door's way in from a requirement (ISS-58): open, or reopen, the person's room about it in
// the chat panel, where the BA assistant asks through the same questionnaire card onboarding uses.

import { useMutation } from "@tanstack/react-query";
import { Button } from "@/design";
import { useChatDock } from "@/features/conversations/dock";
import { formatApiError } from "@/lib/api/error";
import { onboardingApi } from "../api";

export function AskBaAssistant({ projectId, reqKey }: { projectId: string; reqKey: string }) {
  const dock = useChatDock();
  const open = useMutation({
    mutationFn: () => onboardingApi.baRoom(projectId, reqKey),
    onSuccess: (r) => dock?.show({ kind: "room", projectId, conversationId: r.conversation.id }),
  });
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" icon="chat" disabled={open.isPending} onClick={() => open.mutate()}>
        Ask BA assistant
      </Button>
      {open.error && <span className="text-12 text-[color:var(--red-600)]">{formatApiError(open.error)}</span>}
    </span>
  );
}
