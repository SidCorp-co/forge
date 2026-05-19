import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageShell } from "@/components/ui/page-shell";
import { FormInput, FormTextarea } from "@/components/ui/form-input";
import { useProjectSettings } from "./useProjectSettings";
import { invoke } from "@/hooks/use-tauri-ipc";
import { useAppStore } from "@/stores/app-store";

export function ProjectSettings() {
  const {
    slug,
    documentId,
    repoPath,
    setRepoPath,
    branch,
    setBranch,
    instructions,
    setInstructions,
    saved,
    saving,
    saveLog,
    indexingRepo,
    indexStatus,
    indexLog,
    handleIndex,
    handleSave,
  } = useProjectSettings();
  const runnerBindings = useAppStore((s) => s.runnerBindings);
  const runnerOnline = documentId
    ? runnerBindings[documentId]?.status === "online"
    : false;

  async function handleBrowse() {
    try {
      const selected = await invoke<string | null>("pick_directory");
      if (selected) setRepoPath(selected);
    } catch {
      // Fallback: user types manually
    }
  }

  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [indexLog.length]);

  // Skill sync log — reads from local file, auto-refreshes when WebSocket push invalidates
  const { data: syncLog } = useQuery({
    queryKey: ["skill-sync-log"],
    queryFn: () => invoke<{ timestamp: number; entries: Array<{ skill: string; action: string; detail: string }> } | null>("read_sync_log"),
  });

  return (
    <PageShell title="Project Settings" subtitle={slug}>
      <div className="space-y-6">
        {documentId && (
          <div className="text-xs">
            {runnerOnline ? (
              <span className="rounded bg-green-100 px-2 py-0.5 font-medium text-green-700">
                Active runner here
              </span>
            ) : (
              <span className="rounded bg-gray-100 px-2 py-0.5 font-medium text-gray-600">
                Not bound on this device
              </span>
            )}
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm text-gray-600">Local Repo Path</label>
          <div className="flex gap-2">
            <FormInput
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="e.g. C:\projects\my-app"
              className="flex-1"
            />
            <button
              onClick={handleBrowse}
              className="shrink-0 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600 hover:bg-gray-200"
            >
              Browse
            </button>
          </div>
          <p className="mt-1 text-xs text-gray-400">
            Path to the git repo on this machine. Used by Claude CLI agent.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600">Branch</label>
          <div className="flex gap-2">
            <FormInput
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="flex-1"
            />
            {repoPath && (
              <button
                onClick={handleIndex}
                disabled={!!indexingRepo}
                className="shrink-0 rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
              >
                {indexingRepo ? "Indexing..." : "Index Codebase"}
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-400">
            Agent checks out this branch before working. Also used for indexing.
          </p>
          {indexStatus && (
            <p className={`mt-1 text-xs font-medium ${indexStatus.includes("fail") ? "text-red-500" : indexStatus.includes("complete") ? "text-green-600" : "text-blue-500"}`}>
              {indexStatus}
            </p>
          )}
          {indexLog.length > 0 && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-gray-900 p-3 font-mono text-xs text-gray-300">
              {indexLog.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap">{line}</div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600">AI Instructions</label>
          <FormTextarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Custom instructions for AI when working on this project (optional)"
            rows={4}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-black px-6 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {saved && <span className="text-sm text-green-600">Saved!</span>}
        </div>

        {/* Save Log */}
        {saveLog.length > 0 && (
          <div>
            <label className="mb-1 block text-sm text-gray-600">Save Log</label>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-gray-900 p-3 font-mono text-xs text-gray-300">
              {saveLog.map((entry, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  <span className={
                    entry.status === "error" ? "text-red-400"
                      : entry.status === "skip" ? "text-gray-500"
                        : "text-green-400"
                  }>
                    [{entry.status}]
                  </span>{" "}
                  <span className="text-blue-300">{entry.step}</span>
                  {entry.detail && <span className="text-gray-400"> {entry.detail}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Skill Sync Log */}
        <div>
          <div className="flex items-center justify-between">
            <label className="block text-sm text-gray-600">Skill Sync Log</label>
            {syncLog && (
              <span className="text-xs text-gray-400">
                Last sync: {new Date(syncLog.timestamp).toLocaleString()}
              </span>
            )}
          </div>
          {syncLog && syncLog.entries.length > 0 ? (
            <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-gray-900 p-3 font-mono text-xs text-gray-300">
              {syncLog.entries.map((entry, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  <span className={
                    entry.action === "error" ? "text-red-400"
                      : entry.action === "skipped" ? "text-gray-500"
                        : "text-green-400"
                  }>
                    [{entry.action}]
                  </span>{" "}
                  <span className="text-blue-300">{entry.skill}</span>{" "}
                  {entry.detail}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-gray-400">No sync history yet. Skills are synced from the web app.</p>
          )}
        </div>
      </div>
    </PageShell>
  );
}
