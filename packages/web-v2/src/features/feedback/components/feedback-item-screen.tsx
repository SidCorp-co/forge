"use client";

import { DetailHeader, StatusBadge, useListOrigin } from "@/design";
import { useFeedbackItem } from "../hooks";
import { FEEDBACK_LIST, feedbackListHref } from "../../../lib/routes/feedback";
import { FeedbackPage, FeedbackPrimary, useFeedbackTab } from "./feedback-detail";

// The shell's top bar is the page's sticky header (the shared DetailHeader): "← Feedback" back
// to the list view it was opened from, the key, title and phase, and the one primary act
export function FeedbackItemScreen({ projectId, slug, fbKey }: { projectId: string; slug: string; fbKey: string }) {
  const q = useFeedbackItem(projectId, fbKey);
  const [tab, setTab] = useFeedbackTab();
  const back = useListOrigin(FEEDBACK_LIST, feedbackListHref(slug));
  const f = q.data?.feedback;
  const act = () => {
    setTab("overview");
    requestAnimationFrame(() => document.getElementById("feedback-act")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  return (
    <div className="min-h-full bg-app" data-testid="feedback-item-screen">
      <DetailHeader
        back={{ href: back, label: "Feedback" }}
        itemKey={f?.key ?? fbKey}
        keyTitle={f?.id}
        title={f?.title ?? fbKey}
        badge={f ? <StatusBadge family="feedbackPhase" value={f.phase} /> : null}
        action={f ? <FeedbackPrimary f={f} onAct={act} /> : null}
      />
      <FeedbackPage projectId={projectId} slug={slug} fbKey={fbKey} tab={tab} onTab={setTab} />
    </div>
  );
}
