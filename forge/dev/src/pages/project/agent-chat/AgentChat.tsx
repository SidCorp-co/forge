import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChatView } from "@/components/chat-view";
import { ChatSendProvider } from "@/components/chat-send-context";
import { DiffSummary, type BranchDiff } from "@/components/diff-summary";
import { PanelHeader } from "@/components/ui/panel-header";
import { useAgentChat } from "./useAgentChat";
import { RepoWarning } from "./RepoWarning";
import { AgentChatPicker } from "./AgentChatPicker";
import { AgentChatPromptReview } from "./AgentChatPromptReview";
import { AgentChatInput } from "./AgentChatInput";
import { AgentUsageBar } from "./AgentUsageBar";

type ViewTab = "chat" | "changes";

export function AgentChat() {
  const {
    slug, setSearchParams, activeItem, hasRepoPath, repoPath,
    messages, input, setInput, isRunning, claudeSessionId,
    mode, setMode, promptDraft, setPromptDraft, confirmed, setConfirmed,
    savedSessions, loadingSessions, runnableIssues, runnableTasks,
    activeTitle, activeDescription, getActivePrompt,
    handleSend, handleRunAgent, handleAbort, handleOpenTerminal,
    handleNewChat, restoredSessionTitle, handleRestoreSession, handleDeleteSession,
  } = useAgentChat();

  const [viewTab, setViewTab] = useState<ViewTab>("chat");
  const [diff, setDiff] = useState<BranchDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const hasSession = !!restoredSessionTitle;
  const hasMessages = messages.length > 0;
  // TODO: worktreeBranch is not yet plumbed from useAgentChat — changes tab
  // will be enabled once worktree tracking is wired through the hook.
  const worktreeBranch: string | undefined = undefined;
  const showChangesTab = hasMessages && !!worktreeBranch && !isRunning;

  const fetchDiff = useCallback(async () => {
    if (!repoPath || !worktreeBranch) return;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const result = await invoke<BranchDiff>("get_branch_diff", {
        repoPath,
        branch: worktreeBranch,
        base: "HEAD",
      });
      setDiff(result);
    } catch (e) {
      setDiffError(String(e));
    } finally {
      setDiffLoading(false);
    }
  }, [repoPath, worktreeBranch]);

  // Fetch diff when switching to changes tab
  useEffect(() => {
    if (viewTab === "changes") {
      fetchDiff();
    }
  }, [viewTab, fetchDiff]);

  // Auto-switch back to chat when a new run starts
  useEffect(() => {
    if (isRunning) setViewTab("chat");
  }, [isRunning]);

  // Picker screen
  if (!activeItem && !hasSession) {
    return (
      <AgentChatPicker
        slug={slug!}
        hasRepoPath={hasRepoPath}
        runnableIssues={runnableIssues}
        runnableTasks={runnableTasks}
        savedSessions={savedSessions}
        loadingSessions={loadingSessions}
        onSelectIssue={(i) => { setSearchParams({ issueId: i.documentId }); handleNewChat(); }}
        onSelectTask={(t) => { setSearchParams({ taskId: t.documentId }); handleNewChat(); }}
        onRestoreSession={handleRestoreSession}
        onDeleteSession={handleDeleteSession}
        onOpenTerminal={handleOpenTerminal}
        repoPath={repoPath}
      />
    );
  }

  // Prompt review screen
  if (activeItem && !confirmed && promptDraft !== null && messages.length === 0) {
    return (
      <AgentChatPromptReview
        slug={slug!}
        activeTitle={activeTitle}
        hasRepoPath={hasRepoPath}
        promptDraft={promptDraft}
        setPromptDraft={setPromptDraft}
        onBack={() => { setSearchParams({}); setPromptDraft(null); setConfirmed(false); }}
        onStartAgent={() => setConfirmed(true)}
        onStartTerminal={() => { setConfirmed(true); setMode("terminal"); }}
      />
    );
  }

  // Chat view
  const title = hasSession ? restoredSessionTitle : activeTitle;
  const description = hasSession ? "Restored session" : activeDescription;

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        left={
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold text-gray-900">{title}</h1>
            <p className="truncate text-xs text-gray-500">{description}</p>
          </div>
        }
        right={
          <div className="ml-4 flex shrink-0 gap-2">
            <button onClick={handleNewChat} className="rounded bg-gray-100 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200">Back</button>
            {!hasSession && (
              <div className="flex rounded-lg border border-gray-200 bg-white">
                <button onClick={() => setMode("chat")} className={`rounded-l-lg px-3 py-1.5 text-sm ${mode === "chat" ? "bg-black text-white" : "text-gray-500 hover:text-gray-900"}`}>In-App</button>
                <button onClick={() => setMode("terminal")} className={`rounded-r-lg px-3 py-1.5 text-sm ${mode === "terminal" ? "bg-black text-white" : "text-gray-500 hover:text-gray-900"}`}>Terminal</button>
              </div>
            )}
            {mode === "terminal" && !hasSession ? (
              <button onClick={handleOpenTerminal} disabled={!hasRepoPath} className="rounded bg-black px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">Open Claude CLI</button>
            ) : (
              <>
                {isRunning ? (
                  <button onClick={handleAbort} className="rounded bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-500">Stop</button>
                ) : activeItem ? (
                  <button onClick={handleRunAgent} disabled={!hasRepoPath} className="rounded bg-black px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">Run Agent</button>
                ) : null}
                <button onClick={handleNewChat} className="rounded bg-gray-100 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200" title="New conversation">New</button>
              </>
            )}
          </div>
        }
      />

      {!hasRepoPath && <RepoWarning slug={slug!} />}

      {mode === "terminal" && !hasSession ? (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-6">
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Context</h2>
              <pre className="whitespace-pre-wrap text-xs text-gray-500">{getActivePrompt()}</pre>
            </div>
            <p className="mt-4 text-center text-sm text-gray-500">Click "Open Claude CLI" to start an interactive session with this context.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Chat/Changes tab bar */}
          {showChangesTab && (
            <div className="flex border-b border-[#333333] bg-[#111111]">
              <button
                onClick={() => setViewTab("chat")}
                className={`px-4 py-2 text-xs font-medium ${viewTab === "chat" ? "border-b-2 border-white text-white" : "text-[#666666] hover:text-[#999999]"}`}
              >
                Chat
              </button>
              <button
                onClick={() => setViewTab("changes")}
                className={`px-4 py-2 text-xs font-medium ${viewTab === "changes" ? "border-b-2 border-white text-white" : "text-[#666666] hover:text-[#999999]"}`}
              >
                Changes
                {diff && diff.files.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-[#333333] px-1.5 py-0.5 text-[10px]">
                    {diff.files.length}
                  </span>
                )}
              </button>
            </div>
          )}

          {viewTab === "changes" && showChangesTab ? (
            <DiffSummary diff={diff} loading={diffLoading} error={diffError} />
          ) : (
            <>
              {messages.length === 0 ? (
                <div className="flex flex-1 items-center justify-center bg-[#0c0c0c] p-4">
                  <div className="text-center font-mono text-sm text-[#666666]">
                    Send a message or click "Run Agent" to start.
                    {claudeSessionId && <p className="mt-1 text-xs text-[#444444]">Session: {claudeSessionId.slice(0, 8)}...</p>}
                  </div>
                </div>
              ) : (
                <ChatSendProvider send={(text: string) => handleSend(text)}>
                  <ChatView messages={messages} />
                </ChatSendProvider>
              )}
              {isRunning && messages[messages.length - 1]?.type !== "assistant" && (
                <div className="bg-[#0c0c0c] px-4 pb-2">
                  <div className="inline-block font-mono text-sm text-[#666666]"><span className="animate-pulse">Thinking...</span></div>
                </div>
              )}
              <AgentUsageBar />
              <AgentChatInput
                input={input}
                setInput={setInput}
                isRunning={isRunning}
                hasRepoPath={hasRepoPath}
                claudeSessionId={claudeSessionId}
                onSend={handleSend}
                onOpenTerminal={handleOpenTerminal}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
