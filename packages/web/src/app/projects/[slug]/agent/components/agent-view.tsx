'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { AgentSidebar } from './agent-sidebar';
import { AgentChatArea } from './agent-chat-area';
import { useAgentPage } from '../hooks';

function useResizablePanel(
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
  storageKey?: string,
) {
  const [width, setWidth] = useState(defaultWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    setWidth(Math.min(maxWidth, Math.max(minWidth, parsed)));
  }, [storageKey, minWidth, maxWidth]);

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

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

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 768px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isDesktop;
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
    handleRetrySend,
    relayTimedOut,
    isSessionOwner,
    connectionState,
    reconnectNow,
    handleAfterFork,
    handleRerun,
    isTerminal,
  } = useAgentPage();

  const { width: sidebarWidth, onMouseDown: onDividerMouseDown } = useResizablePanel(256, 180, 400, 'agent-sidebar-width');
  const isDesktop = useIsDesktop();

  const activeSession = sessionId
    ? sessions.find((s) => s.documentId === sessionId) ?? null
    : null;
  const sessionTitle = sessionId
    ? (activeSession?.title || 'Agent Chat')
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
        width={isDesktop ? sidebarWidth : undefined}
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
        activeSession={activeSession}
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
        connectionState={connectionState}
        onReconnect={reconnectNow}
        desktopConnected={desktopConnected}
        relayTimedOut={relayTimedOut}
        onRetrySend={handleRetrySend}
        onRerun={handleRerun}
        onAfterFork={handleAfterFork}
        isTerminal={isTerminal}
      />
    </div>
  );
}
