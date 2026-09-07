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
// cm:why List is the default view and not Board (ISS-436) — the board hides draft+closed, so it opened empty on the projects that had shipped most of their work
import { useEffect, useState } from "react";
import { IssuesInsightsView } from "./issues-insights-view";
import { ModuleRollupView } from "./module-rollup-view";
import { IssuesListView } from "./issues-list-view";
import { ReleaseGatePanel } from "./release-gate-panel";
import { NewIssueDialog } from "./new-issue-dialog";

type IssuesView = "board" | "list" | "insights" | "modules";
const VIEWS = ["list", "board", "insights", "modules"] as const;
const VIEW_OPTIONS: SegmentOption<IssuesView>[] = [
  { value: "list", label: "List", icon: "list" },
  { value: "board", label: "Board", icon: "board" },
  { value: "insights", label: "Insights", icon: "activity" },
  { value: "modules", label: "Modules", icon: "book" },
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
          {view === "list" ? <ReleaseGatePanel projectId={scope.projectId} /> : null}
          {view === "list" ? (
            <IssuesListView
              scope={scope}
              canWrite={canWrite}
              onNewIssue={canWrite ? () => setNewOpen(true) : undefined}
            />
          ) : view === "modules" ? (
            <ModuleRollupView scope={scope} />
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
