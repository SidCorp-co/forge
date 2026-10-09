"use client";

// The conversation the project home opens on: the composer and its thread, the same room the chat
// dock would open (`openingTarget`), drawn in the page. It mounts `ConversationChat` as it is, so the
// answers, the decision buttons under a turn and the page actions behave as they do in the dock.

import { useState } from "react";
import { ErrorState } from "@/design";
import { openingTarget } from "@/features/chat-dock/dock-target";
import { ConversationChat } from "@/features/conversations/components/conversation-chat";
import { useProjectConversations } from "@/features/conversations/hooks";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";

export function HomeChat({ projectId }: { projectId: string }) {
  const t = useCopy();
  const q = useProjectConversations(projectId);
  // the room is picked once, from the first read; a later read must not swap the room under a typing person
  const [room, setRoom] = useState<{ id: string | undefined } | null>(null);
  if (!room && q.data) {
    const target = openingTarget(q.data, { projectId, pageKey: null });
    setRoom({ id: target.kind === "room" ? target.conversationId : undefined });
  }
  return (
    <section aria-label={t("home.chat.aria")} data-testid="home-chat" className="flex h-[70dvh] min-h-[26rem] min-w-0 flex-col border border-line bg-surface">
      {q.isError ? (
        <ErrorState title={t("shell.dock.listUnread")} message={formatApiError(q.error)} onRetry={() => void q.refetch()} />
      ) : room ? (
        <ConversationChat projectId={projectId} conversationId={room.id} />
      ) : (
        <p className="fg-body-sm p-4 text-muted">{t("shell.dock.opening")}</p>
      )}
    </section>
  );
}
