"use client";

import { Button, PageTitle, TopBarActions, useViewMode, type ViewMode, ViewModeSwitcher } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { useProjectModules } from "../hooks";
import { IssuesBoard } from "./issues-board";
import { IssuesListView } from "./issues-list-view";
import { useIssueStanding } from "../hooks";
import { ReleaseApprovalProvider } from "../release-approval";
import { NewIssueDialog } from "./new-issue-dialog";

interface IssuesScreenProps {
  scope: { projectId: string; slug: string };
}

type Mode = "attention" | "module" | "waves" | "table";

// the view mode is a choice about the whole page, so it sits in the top header (FB-7, ISS-66);
// Table keeps the paged list with bulk actions and the assistant's ui.select, which the grouped views
// do not carry
function useModes(projectId: string): ViewMode<Mode>[] {
  const modules = useProjectModules(projectId);
  const none = modules.data !== undefined && modules.modules.length === 0;
  const t = useCopy();
  return useMemo(
    () => [
      { value: "attention", label: t("issues.mode.attention"), title: t("issues.mode.attentionHint") },
      {
        value: "module",
        label: t("issues.mode.module"),
        title: none ? t("issues.mode.moduleNone") : t("issues.mode.moduleHint"),
        disabled: none,
      },
      { value: "waves", label: t("issues.mode.waves"), title: t("issues.mode.wavesHint") },
      { value: "table", label: t("issues.mode.table"), title: t("issues.mode.tableHint") },
    ],
    [none, t],
  );
}

export function IssuesScreen({ scope }: IssuesScreenProps) {
  const projectsQ = useProjects();
  const canWrite = canWriteProject(projectsQ.data?.find((p) => p.id === scope.projectId)?.role);
  const modes = useModes(scope.projectId);
  const t = useCopy();
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

  // the Table draws its rows from the issue list, which carries no project rule; the standing read
  // (shared with the grouped views' cache) says whether a release needs a person's approval
  const releaseApproval = useIssueStanding(scope.projectId, "open").data?.releaseApproval;

  const header = (
    <>
      <PageTitle
        hint={t("issues.screen.hint")}
        after={<ViewModeSwitcher modes={modes} value={mode} onChange={setMode} placement="header" />}
      >
        {t("issues.screen.title")}
      </PageTitle>
      {canWrite && (
        <TopBarActions>
          <Button variant="primary" size="sm" icon="plus" onClick={() => setNewOpen(true)}>
            {t("issues.newIssue")}
          </Button>
        </TopBarActions>
      )}
    </>
  );
  const narrowSwitch = <ViewModeSwitcher modes={modes} value={mode} onChange={setMode} placement="toolbar" />;

  return (
    <>
      {/* no page container: the list is flush with the sidebar edge, and only the toolbar keeps a gutter (ISS-49); the title, the view mode and New issue sit in the top bar */}
      <div className="flex min-h-full flex-col pb-6">
        {header}
        {mode === "table" ? (
          <ReleaseApprovalProvider value={releaseApproval}>
            <div className="px-3 pt-2.5 md:hidden">{narrowSwitch}</div>
            <IssuesListView scope={scope} canWrite={canWrite} onNewIssue={canWrite ? () => setNewOpen(true) : undefined} />
          </ReleaseApprovalProvider>
        ) : (
          <IssuesBoard scope={scope} mode={mode} toolbarLead={narrowSwitch} />
        )}
      </div>

      <NewIssueDialog open={newOpen && canWrite} onClose={closeNew} scope={scope} />
    </>
  );
}
