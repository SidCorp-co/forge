
// An interactive session's body: the conversation thread with its composer, beside the context rail
// (a sticky rail from 1024px, a slide-over below it).
import { type ReactNode, useState } from "react";
import { EmptyState, FactsRail, ProjectLoader, SlideOver, useElapsed } from "@/design";
import { useInterruptSession } from "@/features/sessions";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { SteerPriority } from "@/features/chat";
import { DisclosureScope } from "../disclosure";
import { useEditTurn, useRegenerateTurn, useSendMessage, type useSession, type useSessionTurnPages } from "../hooks";
import { contextShare, liveItem, liveStatus, useLiveTurn } from "../live";
import type { ConversationItem } from "../types";
import { ContextRail } from "./context-rail";
import { Conversation } from "./conversation";
import { NewOutput } from "./new-output";
import { SessionComposer } from "./session-composer";
import { sessionTurnStage, TurnStage } from "./turn-stage";
import { tailOutputSize, useStickToBottom } from "./use-stick-to-bottom";

type SessionDetail = NonNullable<ReturnType<typeof useSession>["data"]>;
type TurnsQuery = ReturnType<typeof useSessionTurnPages>["turnsQ"];

interface SessionThreadProps {
  session: SessionDetail;
  items: ConversationItem[];
  turnsQ: TurnsQuery;
  truncated: boolean;
  live: boolean;
  display: Parameters<typeof sessionTurnStage>[0]["display"];
  projectSlug: string | undefined;
  /** The developer view: the agent's tool calls and the context rail; a person reads what was said. */
  developer: boolean;
  railCollapsed: boolean;
  railOpen: boolean;
  onCloseRail: () => void;
  onFork: (turnId: string) => void;
  turnsError: ReactNode;
  turnsTruncated: ReactNode;
}

export function SessionThread({
  session,
  items,
  turnsQ,
  truncated,
  live,
  display,
  projectSlug,
  developer,
  railCollapsed,
  railOpen,
  onCloseRail,
  onFork: handleFork,
  turnsError,
  turnsTruncated,
}: SessionThreadProps) {
  const t = useCopy();
  const time = useTimeFormat();
  const sessionId = session.id;
  const send = useSendMessage(sessionId);
  const interrupt = useInterruptSession();
  const [priority, setPriority] = useState<SteerPriority>("now");
  // what the running turn produces now, streamed until the transcript holds it (ISS-1268)
  const liveTurn = useLiveTurn(sessionId);
  const streamed = liveItem(liveTurn, turnsQ.dataUpdatedAt);
  const shown = streamed ? [...items, streamed] : items;
  const held = live ? liveStatus(liveTurn, t, (s) => time.clock(s * 1000)) : null;
  const context = contextShare(liveTurn);
  const regenerate = useRegenerateTurn(sessionId);
  const editTurn = useEditTurn(sessionId);
  const streaming = live && !truncated;
  const startMs = session.startedAt ? new Date(session.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);

  // What this turn is doing, in the one line that replaced the `AgentWorking` card below the
  // thread (ISS-1083). Which statuses draw which stage is `sessionTurnStage`'s.
  const stage = sessionTurnStage({ live, display, truncated, ...(shown.length ? { tail: shown[shown.length - 1] } : {}) });

  // Auto-scroll the thread to the newest message (ISS-728).
  const { scrollRef, onScroll, atBottom, newOutput, toBottom } = useStickToBottom({
    conversationKey: sessionId,
    ready: turnsQ.isSuccess,
    itemCount: shown.length,
    live,
    streaming,
    streamedChars: tailOutputSize(shown),
  });

  return (
    <>
      <DisclosureScope atBottom={atBottom}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 xl:max-w-5xl">
              {turnsQ.isLoading ? (
                <ProjectLoader label={t("sessions.detail.loadingTurns")} size={110} />
              ) : shown.length === 0 && turnsError ? (
                turnsError
              ) : shown.length === 0 ? (
                live ? null : (
                  <EmptyState message={t("sessions.detail.noMessages")} />
                )
              ) : (
                <Conversation
                  items={shown}
                  agentText={developer}
                  streaming={streaming}
                  busy={
                    live ||
                    send.isPending ||
                    regenerate.isPending ||
                    editTurn.isPending
                  }
                  onRegenerate={(turnId) => regenerate.mutate(turnId)}
                  onFork={handleFork}
                  onEditTurn={(turnId, content, expectedEditedAt) =>
                    editTurn.mutate({ turnId, content, expectedEditedAt })
                  }
                />
              )}
              {items.length > 0 && turnsError}
              {turnsTruncated}
              {stage && (
                <div className="mt-3">
                  <TurnStage stage={stage} status={held} context={live ? context : null} {...(elapsed ? { elapsed } : {})} />
                </div>
              )}
              {newOutput && <NewOutput onGo={toBottom} />}
            </div>
          </div>
          <SessionComposer
            projectId={session.projectId}
            onSend={async (message, files) => {
              // a message for the running turn steers it or waits for it (ISS-1268)
              await send.mutateAsync({ sessionId, message, files, ...(live ? { priority } : {}) });
            }}
            busy={live || send.isPending}
            disabled={!session.deviceId}
            steer={{ priority, onPriority: setPriority }}
            {...(live && session.status === "running" ? { onStop: () => interrupt.mutate(sessionId), stopping: interrupt.isPending } : {})}
            suggestion={live ? null : (liveTurn?.suggestion ?? null)}
          />
        </div>

        {/* Desktop rail — collapsible (persisted); hidden when collapsed so main
            widens. Pinned below the sticky header (parity with the issue
            Properties rail, ISS-351) so context stays visible while the thread
            scrolls; its own `overflow-y-auto` keeps a long rail usable. */}
        {developer && !railCollapsed && (
          <FactsRail belowHeader className="hidden w-80 shrink-0 self-start lg:block" label={t("sessions.detail.context")}>
            <ContextRail session={session} items={items} projectSlug={projectSlug} />
          </FactsRail>
        )}
      </div>
      </DisclosureScope>
      {/* Mobile rail */}
      <SlideOver
        open={developer && railOpen}
        onClose={onCloseRail}
        title={t("sessions.detail.context")}
        width={360}
      >
        <div className="px-4 py-4">
          <ContextRail session={session} items={items} />
        </div>
      </SlideOver>
    </>
  );
}
