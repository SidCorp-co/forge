'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { AgentSidebar } from './agent-sidebar';
import { AgentChatArea } from './agent-chat-area';
import { useAgentPage } from '../hooks';

function useResizablePanel(defaultWidth: number, minWidth: number, maxWidth: number) {
  const [width, setWidth] = useState(defaultWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    e.preventDefault();
  }, [width]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(Math.min(maxWidth, Math.max(minWidth, startWidth.current + (e.clientX - startX.current))));
    };
    const onMouseUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [minWidth, maxWidth]);

  return { width, onMouseDown };
}

export function AgentView() {
  const {
    slug,
    sessions,
    loadingSessions,
    activeSessionId,
    desktopConnected,
    showSessions,
    setShowSessions,
    messages,
    isRunning,
    sessionId,
    draftPrompt,
    isBuildingPrompt,
    editablePrompt,
    setEditablePrompt,
    usage,
    abortAgent,
    viewTab,
    setViewTab,
    showChangesTab,
    diff,
    diffLoading,
    handleNewChat,
    handleSearchSessions,
    handleSelectSession,
    handleSend,
    handleStartFromPrompt,
    handleCancelDraft,
    isSessionOwner,
  } = useAgentPage();

  const { width: sidebarWidth, onMouseDown: onDividerMouseDown } = useResizablePanel(256, 180, 400);

  const sessionTitle = sessionId
    ? (sessions.find((s) => s.documentId === sessionId)?.title || 'Agent Chat')
    : 'New Agent Chat';

  return (
    <div className="flex flex-1 min-h-0 bg-background overflow-hidden md:rounded-lg md:border md:border-surface-variant">
      <AgentSidebar
        slug={slug}
        sessions={sessions}
        loadingSessions={loadingSessions}
        activeSessionId={activeSessionId}
        desktopConnected={desktopConnected}
        showSessions={showSessions}
        onNewChat={handleNewChat}
        onSelectSession={handleSelectSession}
        onSearch={handleSearchSessions}
        width={sidebarWidth}
      />

      {/* Resizable divider — desktop only */}
      <div
        onMouseDown={onDividerMouseDown}
        className="hidden md:flex w-1 cursor-col-resize items-center justify-center hover:bg-outline-variant active:bg-primary-fixed transition-colors bg-surface-variant shrink-0"
      >
        <div className="w-0.5 h-8 rounded-full bg-primary-fixed" />
      </div>

      <AgentChatArea
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        showSessions={showSessions}
        onShowSessions={() => setShowSessions(true)}
        messages={messages}
        isRunning={isRunning}
        usage={usage}
        draftPrompt={draftPrompt}
        isBuildingPrompt={isBuildingPrompt}
        editablePrompt={editablePrompt}
        onEditablePromptChange={setEditablePrompt}
        onCancelDraft={handleCancelDraft}
        onStartFromPrompt={handleStartFromPrompt}
        viewTab={viewTab}
        setViewTab={setViewTab}
        showChangesTab={showChangesTab}
        diff={diff}
        diffLoading={diffLoading}
        onSend={handleSend}
        onStop={abortAgent}
        isSessionOwner={isSessionOwner}
      />
    </div>
  );
}
