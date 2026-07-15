"use client";

import {
  Button,
  PageContainer,
  type SegmentOption,
  SegmentedControl,
} from "@/design";
import { PipelineBoard } from "@/features/pipeline/components/pipeline-board";
import { useProjects } from "@/features/projects/hooks";
import { useTabParam } from "@/lib/utils/use-tab-param";
// web-v2 Issues screen (`/projects/[slug]/issues`). Redesigned to the
// 3-view layout from `design/draft-screen/02 Issues.html` (ISS-364): a
// List / Board / Insights switcher in the header.
//   • List     → the dense table/cards body (search/filter/group/sort/
//                inline-edit/pagination), `IssuesListView`. DEFAULT view
//                (ISS-436 — the board hides draft+closed, so it opened empty
//                on mostly-shipped projects).
//   • Board    → the 7-stage pipeline kanban (embedded PipelineBoard).
//   • Insights → per-stage funnel + throughput + where-time-goes analytics.
// Active view persists in `?tab=` (param-preserving, ISS-331) so it survives
// reload and never clobbers the List view's `?q/filter/groupBy/sort/page`.
import { useEffect, useState } from "react";
import { IssuesInsightsView } from "./issues-insights-view";
import { IssuesListView } from "./issues-list-view";
import { NewIssueDialog } from "./new-issue-dialog";

type IssuesView = "board" | "list" | "insights";
const VIEWS = ["list", "board", "insights"] as const;
const VIEW_OPTIONS: SegmentOption<IssuesView>[] = [
  { value: "list", label: "List", icon: "list" },
  { value: "board", label: "Board", icon: "board" },
  { value: "insights", label: "Insights", icon: "activity" },
];

interface IssuesScreenProps {
  scope: { projectId: string; slug: string };
}

export function IssuesScreen({ scope }: IssuesScreenProps) {
  const [view, setView] = useTabParam<IssuesView>(VIEWS, "list");
  // Viewer = read-only: hide write affordances (the server 403s regardless).
  const projectsQ = useProjects();
  const canWrite =
    projectsQ.data?.find((p) => p.id === scope.projectId)?.role !== "viewer";
  // New-issue dialog — opened locally or via a `?new=1` deep-link (the global
  // TopBar / ⌘K "New issue" actions route here with that param).
  const [newOpen, setNewOpen] = useState(false);

  // On mount: honour `?new=1`. (Old deep-links carrying list params but no
  // `?tab=` need no special-casing anymore — List IS the default view.)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("new") === "1") setNewOpen(true);
  }, []);

  const header = (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3 sm:mb-6">
      <div>
        {/* Two headings, only one ever visible per breakpoint (`hidden` is
            display:none, so assistive tech only sees the active one) — avoids
            depending on a responsive variant of the custom `fg-h*` classes,
            which aren't registered as Tailwind utilities. */}
        <h1 className="fg-h3 sm:hidden">Issues</h1>
        <h1 className="fg-h2 hidden sm:block">Issues</h1>
        <p className="fg-body-sm mt-1 hidden text-muted sm:block">
          One strict pipeline, left to right.
        </p>
      </div>
      <div className="flex items-center gap-3">
        {canWrite && (
          <Button
            variant="primary"
            size="sm"
            icon="plus"
            aria-label="New issue"
            className="min-h-11 sm:min-h-0"
            onClick={() => setNewOpen(true)}
          >
            <span className="hidden sm:inline">New issue</span>
          </Button>
        )}
        <div className="overflow-x-auto">
          <SegmentedControl
            options={VIEW_OPTIONS}
            value={view}
            onChange={setView}
          />
        </div>
      </div>
    </header>
  );

  return (
    <>
      {view === "board" ? (
        // Board needs the full-height flex column the standalone /pipeline route
        // gets, so it lives outside PageContainer and scrolls horizontally.
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex-none px-4 pt-5 sm:px-6 sm:pt-6">{header}</div>
          <div className="min-h-0 flex-1">
            <PipelineBoard scope={scope} embedded canWrite={canWrite} />
          </div>
        </div>
      ) : (
        <PageContainer className="min-h-dvh">
          {header}
          {view === "list" ? (
            <IssuesListView
              scope={scope}
              canWrite={canWrite}
              onNewIssue={canWrite ? () => setNewOpen(true) : undefined}
            />
          ) : (
            <IssuesInsightsView scope={scope} />
          )}
        </PageContainer>
      )}

      <NewIssueDialog
        open={newOpen && canWrite}
        onClose={() => setNewOpen(false)}
        scope={scope}
      />
    </>
  );
}
