import { useState } from "react";
import { invoke } from "@/hooks/use-tauri-ipc";
import { PanelHeader } from "@/components/ui/panel-header";
import { Skeleton } from "@/components/ui/skeleton";
import type { Issue, Task } from "@/lib/types";
import { PickerSection } from "./PickerSection";
import { RepoWarning } from "./RepoWarning";
import type { SessionMeta } from "./useAgentChatEffects";

const hoverCardClass = "rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-blue-400 hover:shadow-sm";

interface Props {
  slug: string;
  hasRepoPath: boolean;
  runnableIssues: Issue[] | undefined;
  runnableTasks: Task[] | undefined;
  savedSessions: SessionMeta[];
  loadingSessions: boolean;
  onSelectIssue: (item: { documentId: string }) => void;
  onSelectTask: (item: { documentId: string }) => void;
  onRestoreSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onOpenTerminal: () => void;
  repoPath?: string;
}

export function AgentChatPicker({
  slug, hasRepoPath, runnableIssues, runnableTasks,
  savedSessions, loadingSessions,
  onSelectIssue, onSelectTask, onRestoreSession, onDeleteSession, onOpenTerminal,
  repoPath,
}: Props) {
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);

  async function handleCleanupWorktrees() {
    if (!repoPath) return;
    try {
      const removed = await invoke("cleanup_merged_worktrees", { repoPath, mainBranch: "master" }) as string[];
      setCleanupResult(removed.length > 0 ? `Removed ${removed.length} merged worktree(s): ${removed.join(", ")}` : "No merged worktrees to clean up.");
    } catch (err) {
      setCleanupResult(`Cleanup failed: ${err}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        left={<div><h1 className="text-lg font-bold text-gray-900">Agent</h1><p className="text-xs text-gray-500">Select an issue or task, or open Claude CLI directly</p></div>}
        right={hasRepoPath ? <button onClick={onOpenTerminal} className="rounded bg-gray-100 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200">Open Terminal</button> : undefined}
      />
      <div className="flex-1 overflow-y-auto p-6">
        {!hasRepoPath && <RepoWarning slug={slug} />}
        <div className="mx-auto max-w-2xl space-y-6">
          {runnableIssues && runnableIssues.length > 0 && (
            <PickerSection title="Issues" items={runnableIssues} onSelect={onSelectIssue}
              renderMeta={(i) => `${i.status} · ${i.priority}${i.agentStatus ? ` · agent: ${i.agentStatus}` : ""}`} />
          )}
          {runnableTasks && runnableTasks.length > 0 && (
            <PickerSection title="Tasks" items={runnableTasks} onSelect={onSelectTask}
              renderMeta={(t) => `${t.status}${t.agentStatus ? ` · agent: ${t.agentStatus}` : ""}`} />
          )}
          {savedSessions.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold text-gray-500">Saved Sessions</h2>
              <div className="space-y-2">
                {savedSessions.map((s) => (
                  <div key={s.id} className={`flex items-center justify-between ${hoverCardClass}`}>
                    <button onClick={() => onRestoreSession(s.id)} className="flex-1 text-left">
                      <p className="text-sm font-medium text-gray-900">{s.title}</p>
                      <p className="mt-0.5 text-xs text-gray-500">{new Date(s.updated_at).toLocaleString()}</p>
                    </button>
                    <button onClick={() => onDeleteSession(s.id)} className="ml-2 rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50 hover:text-red-600">Delete</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {loadingSessions && (
            <div className="space-y-3">
              <Skeleton className="h-5 w-32 rounded" />
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
            </div>
          )}
          {!loadingSessions && !runnableIssues?.length && !runnableTasks?.length && savedSessions.length === 0 && (
            <div className="flex h-full items-center justify-center text-gray-400">No issues or tasks available.</div>
          )}
          {hasRepoPath && (
            <div className="border-t border-gray-100 pt-4">
              <button onClick={handleCleanupWorktrees} className="text-xs text-gray-400 hover:text-gray-600">
                Cleanup merged worktrees
              </button>
              {cleanupResult && <p className="mt-1 text-xs text-gray-500">{cleanupResult}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
