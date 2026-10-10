"use client";

import { SESSION_ATTACHMENTS } from "@/features/chat";
import { ChatComposer, ReadOnlyComposerNote } from "@/features/chat";
import { useProjects } from "@/features/projects";
import { canWriteProject } from "@/features/projects";

/** A reader gets no composer (the server 403s sends regardless); a writer sends into the session. */
export function SessionComposer({
  projectId,
  onSend,
  busy,
  disabled,
}: {
  projectId: string;
  onSend: (message: string, files: File[]) => Promise<void>;
  busy: boolean;
  disabled: boolean;
}) {
  const projectsQ = useProjects();
  if (!canWriteProject(projectsQ.data?.find((p) => p.id === projectId)?.role)) return <ReadOnlyComposerNote />;
  return <ChatComposer onSend={onSend} busy={busy} disabled={disabled} attachments={SESSION_ATTACHMENTS} />;
}
