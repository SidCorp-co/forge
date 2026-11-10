// The project home (REQ-43 r3 BC-14..BC-18; owner, 2026-11-10): the loop first, Product → Delivery →
// Release → Audit, each stage's figure and parts; Needs you under it; then the shipped and feedback
// charts. Every figure is the one home read's (`GET /api/projects/:id/home`), the same lists the
// Requirements, Issues, Releases and Debt pages read. Detail opens in a stage's drawer, never in place.
// The live bar above the page says what runs now; notifications are not here.

import { useState } from "react";
import { ErrorState, ProjectLoader } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useProjectHome } from "../hooks";
import type { StageId } from "../model";
import { FeedbackChart, ShippedChart } from "./home-charts";
import { Loop, stageViews } from "./loop";
import { NeedsYouRows } from "./needs-you-rows";
import { StageDrawer } from "./stage-drawer";

export function ProjectHome({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const q = useProjectHome(projectId);
  const [open, setOpen] = useState<StageId | null>(null);
  if (q.isError) return <ErrorState title={t("dash.loadFailed")} message={formatApiError(q.error)} onRetry={() => void q.refetch()} />;
  const home = q.data;
  if (!home) {
    return (
      <div className="grid place-items-center py-16" data-testid="home-reading">
        <ProjectLoader label={t("dash.loading")} />
      </div>
    );
  }
  const stages = stageViews(home, t);
  return (
    <div className="flex flex-col gap-4" data-testid="project-home">
      <Loop stages={stages} onOpen={setOpen} />
      <NeedsYouRows slug={slug} needsYou={home.needsYou} />
      <div className="grid grid-cols-1 gap-6 border-t border-line-divider pt-4 md:grid-cols-2">
        <ShippedChart days={home.release.days} />
        <FeedbackChart weeks={home.feedback.weeks} />
      </div>
      <StageDrawer stage={stages.find((s) => s.id === open) ?? null} home={home} slug={slug} onClose={() => setOpen(null)} />
    </div>
  );
}
