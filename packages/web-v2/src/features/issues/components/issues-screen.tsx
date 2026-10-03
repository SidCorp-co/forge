"use client";

import { Button, PageTitle, TopBarActions, useViewMode, type ViewMode, ViewModeSwitcher } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useProjectModules } from "../hooks";
import { IssuesBoard } from "./issues-board";
import { IssuesListView } from "./issues-list-view";
import { NewIssueDialog } from "./new-issue-dialog";

interface IssuesScreenProps {
  scope: { projectId: string; slug: string };
}

type Mode = "attention" | "module" | "waves" | "table";

// cm:why the view mode is a choice about the whole page, so it sits in the top header (FB-7, ISS-66);
// Table keeps the paged list with bulk actions and the assistant's ui.select, which the grouped views
// do not carry
function useModes(projectId: string): ViewMode<Mode>[] {
  const modules = useProjectModules(projectId);
  const none = modules.data !== undefined && modules.modules.length === 0;
  return useMemo(
    () => [
      { value: "attention", label: "Attention", title: "Grouped by whose turn it is" },
      {
        value: "module",
        label: "Module",
        title: none ? "No module is defined on this project yet" : "Grouped by primary module",
        disabled: none,
      },
      { value: "waves", label: "Waves", title: "Columns by layers of open blockers" },
      { value: "table", label: "Table", title: "Every issue, paged, with bulk actions" },
    ],
    [none],
  );
}

export function IssuesScreen({ scope }: IssuesScreenProps) {
  const projectsQ = useProjects();
  const canWrite = canWriteProject(projectsQ.data?.find((p) => p.id === scope.projectId)?.role);
  const modes = useModes(scope.projectId);
  const [mode, setMode] = useViewMode(modes);
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
      <PageTitle
        hint="Every issue on this project, and what each one is waiting on."
        after={<ViewModeSwitcher modes={modes} value={mode} onChange={setMode} placement="header" />}
      >
        Issues
      </PageTitle>
      {canWrite && (
        <TopBarActions>
          <Button variant="primary" size="sm" icon="plus" onClick={() => setNewOpen(true)}>
            New issue
          </Button>
        </TopBarActions>
      )}
    </>
  );
  const narrowSwitch = <ViewModeSwitcher modes={modes} value={mode} onChange={setMode} placement="toolbar" />;

  return (
    <>
      {/* cm:why no page container: the list is flush with the sidebar edge, and only the toolbar keeps a gutter (ISS-49); the title, the view mode and New issue sit in the top bar */}
      <div className="flex min-h-full flex-col pb-6">
        {header}
        {mode === "table" ? (
          <>
            <div className="px-3 pt-2.5 md:hidden">{narrowSwitch}</div>
            <IssuesListView scope={scope} canWrite={canWrite} onNewIssue={canWrite ? () => setNewOpen(true) : undefined} />
          </>
        ) : (
          <IssuesBoard scope={scope} mode={mode} toolbarLead={narrowSwitch} />
        )}
      </div>

      <NewIssueDialog open={newOpen && canWrite} onClose={closeNew} scope={scope} />
    </>
  );
}
