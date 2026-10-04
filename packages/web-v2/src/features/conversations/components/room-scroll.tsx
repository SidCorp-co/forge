"use client";

import { type ReactNode, useMemo } from "react";
import { EmptyState } from "@/design";
import { NewOutput } from "@/features/session/components/new-output";
import { TurnStage, turnStageOf } from "@/features/session/components/turn-stage";
import { useStickToBottom } from "@/features/session/components/use-stick-to-bottom";
import { parseMessages } from "@/features/session/types";
import type { ConversationProgressEntry } from "../types";

/** The room's scrolling body: it sticks to the bottom while the agent writes, and shows its stage. */
export function RoomScroll({
  conversationKey,
  ready,
  itemCount,
  busy,
  progress,
  children,
}: {
  conversationKey: string | undefined;
  ready: boolean;
  itemCount: number;
  busy: boolean;
  progress: ConversationProgressEntry | null | undefined;
  children: (atBottom: boolean) => ReactNode;
}) {
  const streaming = busy || progress != null;
  const streamedChars = useMemo(() => JSON.stringify(progress?.entry ?? null).length, [progress]);
  const stage = turnStageOf({
    live: streaming && !progress?.replaced,
    ...(progress ? { blocks: parseMessages([progress.entry])[0]?.blocks } : {}),
  });
  const { scrollRef, bottomRef, onScroll, atBottom, newOutput, toBottom } = useStickToBottom({
    conversationKey,
    ready,
    itemCount,
    live: busy,
    streaming,
    streamedChars,
  });

  return (
    <div ref={scrollRef} onScroll={onScroll} className="@container min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-3 py-3 @2xl:px-8 @2xl:py-8 xl:max-w-4xl">
        {itemCount === 0 ? (
          <div className="grid min-h-[40dvh] place-items-center">
            <EmptyState
              title="Start a conversation"
              message="Ask the agent anything about this project — its issues, its progress and what it knows."
              mascot
            />
          </div>
        ) : (
          children(atBottom)
        )}
        {stage && (
          <div className="mt-4">
            <TurnStage stage={stage} />
          </div>
        )}
        {newOutput && <NewOutput onGo={toBottom} />}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
