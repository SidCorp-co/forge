"use client";

import { Button, PageContainer, PageTitle } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { IssuesListView } from "./issues-list-view";
import { ReleaseGatePanel } from "./release-gate-panel";
import { NewIssueDialog } from "./new-issue-dialog";

interface IssuesScreenProps {
  scope: { projectId: string; slug: string };
}

export function IssuesScreen({ scope }: IssuesScreenProps) {
  const projectsQ = useProjects();
  const canWrite = canWriteProject(projectsQ.data?.find((p) => p.id === scope.projectId)?.role);
  // New-issue dialog — opened locally or by `?new=1`, which ⌘K pushes onto this
  // route. On this route Next keeps the screen mounted, so the query is followed, not read once.
  const [newOpen, setNewOpen] = useState(false);
  const searchParams = useSearchParams();
  const pathname = usePathname() || "";
  const wantsNew = searchParams.get("new") === "1";

  useEffect(() => {
    if (wantsNew) setNewOpen(true);
  }, [wantsNew]);

  // Closing drops `new` from this entry and keeps the rest, so Back and reload stay shut. The state
  // is `null` because Next skips syncing `useSearchParams` for a state carrying its `__NA` mark.
  const closeNew = useCallback(() => {
    setNewOpen(false);
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (!sp.has("new")) return;
    sp.delete("new");
    const qs = sp.toString();
    window.history.replaceState(null, "", `${pathname}${qs ? `?${qs}` : ""}`);
  }, [pathname]);

  const header = (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3 sm:mb-6">
      <div>
        {/* Two headings, only one ever visible per breakpoint (`hidden` is
            display:none, so assistive tech only sees the active one) — avoids
            depending on a responsive variant of the custom `fg-h*` classes,
            which aren't registered as Tailwind utilities. */}
        <PageTitle className="fg-h3 sm:hidden">Issues</PageTitle>
        <PageTitle className="fg-h2 hidden sm:block">Issues</PageTitle>
        <p className="fg-body-sm mt-1 hidden text-muted sm:block">
          Every issue on this project, and what each one is waiting on.
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
      </div>
    </header>
  );

  return (
    <>
      <PageContainer className="min-h-dvh">
        {header}
        <ReleaseGatePanel projectId={scope.projectId} slug={scope.slug} />
        <IssuesListView
          scope={scope}
          canWrite={canWrite}
          onNewIssue={canWrite ? () => setNewOpen(true) : undefined}
        />
      </PageContainer>

      <NewIssueDialog
        open={newOpen && canWrite}
        onClose={closeNew}
        scope={scope}
      />
    </>
  );
}
