"use client";

import type { ReactNode } from "react";
import type { UiSnapshot } from "@forge/contracts/ui-actions";
import type { ProjectListItem } from "@/features/projects/types";
import { canWriteProject } from "@/features/projects/write-access";
import { CONVERSATION_ATTACHMENTS } from "@/features/chat/attachments";
import { ChatComposer, ReadOnlyComposerNote } from "@/features/chat/components/chat-composer";
import { useDraftAgentMode, useStopConversation } from "../hooks";
import { composerRefusal } from "../membership";
import type { ConversationDetail, ConversationMode } from "../types";
import { seesDetail } from "../ui-actions/use-ui-actions";
import { ConversationModeControl, modePlaceholder } from "./mode-control";

/** The bottom of an open room: why nobody may type here, the box, or the read-only note. */
export function ConversationComposer(props: {
  room: ConversationDetail | undefined;
  projectId: string;
  conversationId: string | undefined;
  project: ProjectListItem | undefined;
  /** The agent is mid-turn, so the box offers Stop. */
  live: boolean;
  busy: boolean;
  onSend: (message: string, files: File[]) => Promise<void>;
  mode: ConversationMode;
  onModeChange: (mode: ConversationMode) => void;
  settledMode: ConversationMode | null;
  initialDraft: string | undefined;
  scopeChip: ReactNode;
  page: { snapshot: UiSnapshot; sees: string | null };
  scope: "project" | "ecosystem";
}) {
  const { room, conversationId, page } = props;
  const stop = useStopConversation();
  const draftOffer = useDraftAgentMode(props.projectId, !conversationId);
  const refusal = room ? composerRefusal(room) : null;
  if (refusal) {
    return (
      <div className="flex-none border-t border-line bg-surface px-4 py-3" data-testid="composer-refused">
        <p className="fg-body-sm text-fg">{refusal.reason}</p>
        <p className="fg-caption mt-0.5 text-muted">{refusal.wayOut}</p>
      </div>
    );
  }
  if (!canWriteProject(props.project?.role)) return <ReadOnlyComposerNote sticky={false} />;
  return (
    <ChatComposer
      onSend={props.onSend}
      busy={props.busy}
      queueWhileBusy
      sticky={false}
      attachments={CONVERSATION_ATTACHMENTS}
      placeholder={modePlaceholder(props.settledMode ?? props.mode)}
      {...(props.live && conversationId
        ? { onStop: () => stop.mutate(conversationId), stopping: stop.isPending }
        : {})}
      {...(props.initialDraft ? { initialValue: props.initialDraft } : {})}
      footerControl={
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ConversationModeControl
            value={props.mode}
            onChange={props.onModeChange}
            offer={room?.agentMode ?? draftOffer.data ?? { available: false, reason: "checking whether a box is free" }}
            settled={props.settledMode}
            disabled={props.busy}
          />
          {props.scopeChip}
          {page.sees && (
            <span
              data-testid="composer-sees"
              title={seesDetail(page.snapshot, { project: props.project?.name ?? null, scope: props.scope })}
              className="fg-caption inline-flex max-w-[16rem] items-center gap-1 truncate text-subtle"
            >
              Sees {page.sees}
            </span>
          )}
        </div>
      }
    />
  );
}
