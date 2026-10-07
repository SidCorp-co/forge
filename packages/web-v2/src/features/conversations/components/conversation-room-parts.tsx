"use client";

import type { ComponentProps, ReactNode } from "react";
import { EmptyState, ErrorState, IconButton, ProjectLoader } from "@/design";
import { ThreadSub } from "@/features/onboarding/components/thread-sub";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { type ConversationMode, type ConversationRow, conversationTitle } from "../types";
import { ConversationModeControl, modePlaceholder } from "./mode-control";

// What a conversation room shows around its thread, in the interface language: the header, the
// loading, unreadable and empty states, and the composer's footer. ConversationChat coordinates the
// room; these parts only say it.

/** The room's title, its thread line, who is in it, and the caller's actions. */
export function RoomHeader({
  room,
  firstSaid,
  projectId,
  onMembers,
  actions,
}: {
  room: ConversationRow | undefined;
  firstSaid: string | undefined;
  projectId: string;
  onMembers: () => void;
  actions: ReactNode;
}) {
  const t = useCopy();
  const untitled = t("shell.dock.newConversation");
  return (
    <header className="@container flex-none border-b border-line bg-app/95 px-3 py-2 @2xl:px-4 @2xl:py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-bold leading-snug text-fg @2xl:text-[22px] @2xl:leading-tight">
            {room ? conversationTitle(room, firstSaid, untitled) : untitled}
          </h2>
          <ThreadSub kind={room?.kind} status={room?.threadStatus} projectId={projectId} />
        </div>
        {room && <IconButton icon="users" size="sm" aria-label={t("shell.chat.members")} onClick={onMembers} />}
        {actions}
      </div>
    </header>
  );
}

export function RoomLoading() {
  const t = useCopy();
  return (
    <div className="grid min-h-0 flex-1 place-items-center py-12">
      <ProjectLoader label={t("shell.chat.loading")} />
    </div>
  );
}

export function RoomUnreadable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useCopy();
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-4 py-12">
      <ErrorState title={t("shell.chat.unread")} message={formatApiError(error)} onRetry={onRetry} />
    </div>
  );
}

export function RoomEmpty() {
  const t = useCopy();
  return (
    <div className="flex min-h-[40dvh] flex-col">
      <div className="grid flex-1 place-items-center">
        <EmptyState title={t("shell.chat.emptyTitle")} message={t("shell.chat.emptyMessage")} mascot />
      </div>
    </div>
  );
}

/** The composer's placeholder: the onboarding job's, or the mode's. */
export function useComposerPlaceholder(onboarding: boolean, mode: ConversationMode): string {
  const t = useCopy();
  return onboarding ? t("shell.chat.onboardingPlaceholder") : modePlaceholder(mode, t);
}

/** The composer's footer: to the onboarding job, or the mode, the room's scope, and what the agent sees. */
export function ComposerFooter({
  onboarding,
  mode,
  scopeChip,
  sees,
}: {
  onboarding: boolean;
  mode: ComponentProps<typeof ConversationModeControl>;
  scopeChip: ReactNode;
  sees: { label: string; detail: string } | null;
}) {
  const t = useCopy();
  if (onboarding) {
    return (
      <span className="fg-caption text-subtle" data-testid="composer-to-onboarding-job">
        {t("shell.chat.toOnboarding")}
      </span>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ConversationModeControl {...mode} />
      {scopeChip}
      {sees && (
        <span
          data-testid="composer-sees"
          title={sees.detail}
          className="fg-caption inline-flex max-w-[16rem] items-center gap-1 truncate text-subtle"
        >
          {t("shell.chat.sees", { what: sees.label })}
        </span>
      )}
    </div>
  );
}
