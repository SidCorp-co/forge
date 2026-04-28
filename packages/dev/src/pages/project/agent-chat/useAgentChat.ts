import { useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getTasks, getIssues } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import type { Issue, AgentMessage } from "@/lib/types";
import { getMcpServersParam, getActivePrompt } from "./agentChatPrompts";
import { useKnowledgeCheck, useAutoPopulatePrompt, useStreamListener, useAutoSave, useLoadSessions } from "./useAgentChatEffects";
import type { SessionMeta } from "./useAgentChatEffects";
import { createHandlers } from "./useAgentChatHandlers";

export type { SessionMeta };

let msgCounter = 0;
function makeMessage(type: AgentMessage["type"], content: string): AgentMessage {
  return { id: `${type}-${++msgCounter}`, type, timestamp: Date.now(), content };
}

export function useAgentChat() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const taskDocId = searchParams.get("taskId");
  const issueDocId = searchParams.get("issueId");
  const issueIdsParam = searchParams.get("issueIds");
  const config = useAppStore((s) => s.config);
  const agentUsage = useAppStore((s) => s.agentUsage);
  const updateAgentUsageFromStored = useAppStore((s) => s.updateAgentUsageFromStored);
  const resetAgentUsage = useAppStore((s) => s.resetAgentUsage);

  const { data: tasks } = useQuery({ queryKey: ["tasks", slug], queryFn: () => getTasks(slug!), enabled: !!slug });
  const { data: issues } = useQuery({ queryKey: ["issues", slug], queryFn: () => getIssues(slug!), enabled: !!slug });

  const issueDocIds = issueIdsParam ? issueIdsParam.split(",") : issueDocId ? [issueDocId] : [];

  const task = tasks?.find((t) => t.documentId === taskDocId);
  const issue = issues?.find((i) => i.documentId === issueDocId);
  const multiIssues = issueIdsParam
    ? issueIdsParam.split(",").map((id) => issues?.find((i) => i.documentId === id)).filter(Boolean) as Issue[]
    : [];
  const activeItem = task || issue || (multiIssues.length > 0 ? multiIssues[0] : null);
  const projectConfig = slug ? config.projects[slug] : undefined;
  const hasRepoPath = !!projectConfig?.repoPath;

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<"chat" | "terminal">("chat");
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const sessionIdRef = useRef<string>(`agent-${Date.now()}`);
  const strapiSessionIdRef = useRef<string | null>(null);
  const [savedSessions, setSavedSessions] = useState<SessionMeta[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [restoredSessionTitle, setRestoredSessionTitle] = useState<string | null>(null);
  const [hasKnowledge, setHasKnowledge] = useState(false);

  useKnowledgeCheck(projectConfig, setHasKnowledge);

  const getActivePromptBound = () => getActivePrompt(confirmed, promptDraft, task, issue, multiIssues);
  const getMcpServersParamBound = () => getMcpServersParam(projectConfig);

  useAutoPopulatePrompt(confirmed, messages.length, getActivePromptBound, setPromptDraft, [task, issue, multiIssues.length, confirmed, messages.length, hasKnowledge]);
  useStreamListener(slug, sessionIdRef, setMessages, setIsRunning, setClaudeSessionId, makeMessage);
  useAutoSave(messages, claudeSessionId, slug, agentUsage, sessionIdRef, strapiSessionIdRef);
  useLoadSessions(activeItem, slug, setLoadingSessions, setSavedSessions);

  const handlers = createHandlers({
    slug, projectConfig, hasRepoPath, isRunning, input, claudeSessionId,
    sessionIdRef, strapiSessionIdRef, issueDocIds,
    setInput, setMessages, setIsRunning, setClaudeSessionId,
    setRestoredSessionTitle, resetAgentUsage, updateAgentUsageFromStored,
    setSavedSessions, makeMessage, getActivePrompt: getActivePromptBound,
    getMcpServersParam: getMcpServersParamBound, activeItem,
  });

  const runnableIssues = issues?.filter((i) => i.status === "approved" || i.status === "in_progress");
  const runnableTasks = tasks?.filter((t) => t.isAgentTask && (t.status === "backlog" || t.status === "todo" || t.status === "in_progress"));

  let activeTitle = "";
  let activeDescription = "";
  if (task) {
    activeTitle = task.title;
    activeDescription = task.description ?? "";
  } else if (multiIssues.length > 1) {
    activeTitle = `${multiIssues.length} issues selected`;
    activeDescription = multiIssues.map((i) => i.title).join(", ");
  } else if (activeItem) {
    activeTitle = (activeItem as Issue).title ?? "";
    activeDescription = (activeItem as Issue).description ?? "";
  }

  return {
    slug, searchParams, setSearchParams, activeItem, hasRepoPath, repoPath: projectConfig?.repoPath,
    messages, input, setInput, isRunning, claudeSessionId,
    mode, setMode, promptDraft, setPromptDraft, confirmed, setConfirmed,
    savedSessions, loadingSessions, runnableIssues, runnableTasks,
    activeTitle, activeDescription, getActivePrompt: getActivePromptBound,
    restoredSessionTitle,
    ...handlers,
  };
}
