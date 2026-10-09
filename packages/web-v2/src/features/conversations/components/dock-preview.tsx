"use client";

// The preview beside the chat (REQ-39 BC-3, BC-6): when the page the dock sits on is an issue whose run
// holds a preview, the dock shows that preview, compact, with the message box that asks the run for a
// change. The page names the issue in its path, so nothing has to register with the dock; no preview
// of the issue, or any other page, draws nothing.

import { useIssue } from "@/features/issues/detail-hooks";
import { settingsHref } from "@/features/project-settings/sections";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";
import { PreviewPanel } from "@/features/previews/preview-panel";

const ISSUE_PAGE = /^\/projects\/[^/]+\/issues\/([^/?#]+)/;

/** The issue a page path is the page of, by the id it carries (a key or a uuid), or null. */
export function issuePageOf(pathname: string | null): string | null {
  const id = ISSUE_PAGE.exec(pathname ?? "")?.[1];
  return id ? decodeURIComponent(id) : null;
}

export function DockPreview({ pathname, projectId }: { pathname: string | null; projectId: string | null }) {
  const id = issuePageOf(pathname);
  if (!id || !projectId) return null;
  return <IssuePreview id={id} projectId={projectId} />;
}

function IssuePreview({ id, projectId }: { id: string; projectId: string }) {
  const issueQ = useIssue(id, projectId);
  const projectsQ = useProjects();
  const issue = issueQ.data;
  if (!issue) return null;
  const project = projectsQ.data?.find((p) => p.id === projectId);
  const role = project?.role;
  return (
    <PreviewPanel
      compact
      className="max-h-[60%] flex-none overflow-y-auto border-b border-line px-3 py-3"
      issueId={issue.id}
      issueLabel={issue.displayId}
      canWrite={canWriteProject(role)}
      settingsHref={project ? settingsHref(project.slug, "preview") : undefined}
      hasLiveRun={(issue.agentSessions ?? []).some((s) => s.status === "running")}
    />
  );
}
