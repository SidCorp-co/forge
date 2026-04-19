import { PanelHeader } from "@/components/ui/panel-header";
import { RepoWarning } from "./RepoWarning";

interface Props {
  slug: string;
  activeTitle: string;
  hasRepoPath: boolean;
  promptDraft: string;
  setPromptDraft: (v: string) => void;
  onBack: () => void;
  onStartAgent: () => void;
  onStartTerminal: () => void;
}

export function AgentChatPromptReview({
  slug, activeTitle, hasRepoPath, promptDraft, setPromptDraft,
  onBack, onStartAgent, onStartTerminal,
}: Props) {
  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        left={<div className="min-w-0 flex-1"><h1 className="truncate text-lg font-bold text-gray-900">{activeTitle}</h1><p className="text-xs text-gray-500">Review and edit the prompt before starting</p></div>}
        right={<button onClick={onBack} className="ml-4 rounded bg-gray-100 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200">Back</button>}
      />
      {!hasRepoPath && <RepoWarning slug={slug} />}
      <div className="flex-1 overflow-y-auto p-6">
        <textarea value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)}
          className="h-full w-full resize-none rounded-lg border border-gray-200 bg-gray-50 p-4 font-mono text-sm text-gray-800 focus:border-blue-400 focus:bg-white focus:outline-none" />
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-gray-200 px-6 py-3">
        <button onClick={onStartAgent} disabled={!hasRepoPath}
          className="rounded-lg bg-black px-6 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">Start Agent</button>
        <button onClick={onStartTerminal} disabled={!hasRepoPath}
          className="rounded bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200 disabled:opacity-50">Open Terminal</button>
      </div>
    </div>
  );
}
