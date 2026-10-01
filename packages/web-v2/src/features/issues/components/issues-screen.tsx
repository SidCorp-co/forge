"use client";

import { Button, PageTitle, TopBarActions } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { IssuesListView } from "./issues-list-view";
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
    <>
      <PageTitle hint="Every issue on this project, and what each one is waiting on.">Issues</PageTitle>
      {canWrite && (
        <TopBarActions>
          <Button variant="primary" size="sm" icon="plus" onClick={() => setNewOpen(true)}>
            New issue
          </Button>
        </TopBarActions>
      )}
    </>
  );

  return (
    <>
      {/* cm:why no page container: the list is one table flush with the sidebar edge, and only the toolbar keeps a gutter (ISS-49); the title and New issue sit in the top bar */}
      <div className="flex min-h-full flex-col pb-6">
        {header}
        <IssuesListView
          scope={scope}
          canWrite={canWrite}
          onNewIssue={canWrite ? () => setNewOpen(true) : undefined}
        />
      </div>

      <NewIssueDialog
        open={newOpen && canWrite}
        onClose={closeNew}
        scope={scope}
      />
    </>
  );
}
