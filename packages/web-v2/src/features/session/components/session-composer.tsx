
import { SESSION_ATTACHMENTS } from "@/features/chat";
import { ChatComposer, ReadOnlyComposerNote, type SteerPriority } from "@/features/chat";
import { useProjects } from "@/features/projects";
import { canWriteProject } from "@/features/projects";

/** A reader gets no composer (the server 403s sends regardless); a writer sends into the session. */
export function SessionComposer({
  projectId,
  onSend,
  busy,
  disabled,
  steer,
  onStop,
  stopping,
  suggestion,
}: {
  projectId: string;
  onSend: (message: string, files: File[]) => Promise<void>;
  busy: boolean;
  disabled: boolean;
  /** A message for the running turn: steer it now or answer after it (ISS-1268). */
  steer?: { priority: SteerPriority; onPriority: (p: SteerPriority) => void };
  /** Stop the running turn; given only while one runs. */
  onStop?: () => void;
  stopping?: boolean;
  /** The next prompt the agent suggests, offered after a turn. */
  suggestion?: string | null;
}) {
  const projectsQ = useProjects();
  if (!canWriteProject(projectsQ.data?.find((p) => p.id === projectId)?.role)) return <ReadOnlyComposerNote />;
  return (
    <ChatComposer
      onSend={onSend}
      busy={busy}
      disabled={disabled}
      attachments={SESSION_ATTACHMENTS}
      {...(steer ? { steer } : {})}
      {...(onStop ? { onStop, stopping: stopping ?? false } : {})}
      suggestion={suggestion ?? null}
    />
  );
}
