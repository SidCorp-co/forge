"use client";

// The peek (`?peek=FB-3`) beside the list: a summary, not the page — the header with the one
// primary act, whose turn it is, and the facts the full page's rail shows.

import { PeekHead, PeekPanel, type PeekState, StatusBadge, QueryBoundary } from "@/design";
import { useFeedbackItem } from "../hooks";
import { FeedbackPrimary } from "./feedback-detail";
import { FeedbackBanner, FeedbackFacts } from "./feedback-facts";

export function FeedbackPeek({
  projectId,
  slug,
  fbKey,
  peek,
  onOpenFull,
}: {
  projectId: string;
  slug: string;
  fbKey: string;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const q = useFeedbackItem(projectId, fbKey);
  return (
    <PeekPanel peek={peek} listLabel="Feedback" noun="Feedback" onOpenFull={onOpenFull} testId="feedback-peek">
      <QueryBoundary query={q} loadingLabel="loading feedback…">
        {(data) => {
          const f = data.feedback;
          return (
            <>
              <PeekHead
                noun="Feedback"
                itemKey={f.key}
                badge={<StatusBadge family="feedbackPhase" value={f.phase} />}
                title={f.title}
                action={<FeedbackPrimary f={f} onAct={onOpenFull} />}
              />
              <FeedbackBanner f={f} className="px-[18px]" />
              <div className="px-[18px] pb-4 pt-4">
                <FeedbackFacts f={f} slug={slug} />
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </PeekPanel>
  );
}
