// What follows one message in a project chat: the lessons it corrected or applied (REQ-50 BC-1, BC-4)
// first, then the UI actions the turn took and the acts it offers (ISS-47), so the thread itself
// composes none of them.

import type { ReactNode } from "react";
import { ChatLessonLine } from "@/features/lessons";

export function EntryAfter({
  entryId,
  lessonsOf,
  cards,
  offers,
}: {
  entryId: string;
  /** The project and room whose lesson lines are drawn; none in a room with no project. */
  lessonsOf: { projectId: string; conversationId: string } | null;
  cards: ReactNode;
  offers: ReactNode;
}) {
  return (
    <>
      {lessonsOf ? <ChatLessonLine projectId={lessonsOf.projectId} conversationId={lessonsOf.conversationId} messageId={entryId} /> : null}
      {cards}
      {offers}
    </>
  );
}
