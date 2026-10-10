
import { Button, PageTitle, TopBarActions, useViewMode, type ViewMode, ViewModeSwitcher } from "@/design";
import { useProjects } from "@/features/projects";
import { canWriteProject } from "@/features/projects";
import { useSearchParams } from "@/lib/navigation/router";
import { useState } from "react";
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
  const none = modules.data !== undefined && modules.data.length === 0;
  const t = useCopy();
  return [
    { value: "attention", label: t("issues.mode.attention") },
    {
      value: "module",
      label: t("issues.mode.module"),
      title: none ? t("issues.mode.moduleNone") : undefined,
      disabled: none,
    },
    { value: "waves", label: t("issues.mode.waves") },
    { value: "table", label: t("issues.mode.table") },
  ];
}

export function IssuesScreen({ scope }: IssuesScreenProps) {
  const projectsQ = useProjects();
  const canWrite = canWriteProject(projectsQ.data?.find((p) => p.id === scope.projectId)?.role);
  const modes = useModes(scope.projectId);
  const t = useCopy();
  const [mode, setMode] = useViewMode(modes);
  // New-issue dialog — opened locally or by `?new=1`, which ⌘K pushes onto this
  // route. The router keeps the screen mounted on this route, so the query is followed, not read once.
  const [newOpen, setNewOpen] = useState(false);
  const searchParams = useSearchParams();
  const wantsNew = searchParams.get("new") === "1";

  const showNew = newOpen || wantsNew;

  // Closing drops `new` from this entry and keeps the rest, so Back and reload stay shut. The
  // router hears the replace and keeps its own entry state, which Back reads.
  const closeNew = () => {
    setNewOpen(false);
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (!sp.has("new")) return;
    sp.delete("new");
    const qs = sp.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  };

  // the Table draws its rows from the issue list, which carries no project rule; the standing read
  // (shared with the grouped views' cache) says whether a release needs a person's approval
  const releaseApproval = useIssueStanding(scope.projectId, "open").data?.releaseApproval;

  const header = (
    <>
      <PageTitle
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

      <NewIssueDialog open={showNew && canWrite} onClose={closeNew} scope={scope} />
    </>
  );
}
