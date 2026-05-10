'use client';

import { useEffect, useRef, useState } from 'react';
import { List, RotateCcw } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { ChatMessages } from '@/components/chat/chat-messages';
import { ChatInput } from '@/components/chat/chat-input';
import { BranchDiffSummary } from '@/components/chat/branch-diff-summary';
import { PromptEditor } from './prompt-editor';
import { formatTokens, CONTEXT_LIMIT } from '@/lib/utils/format-tokens';
import { cn } from '@/lib/utils/cn';
import type { ViewTab } from '../hooks';
import type { BranchDiff } from '@/features/agent/api';
import type { ChatMessageData } from '@/components/chat/chat-message';
import { ChatSendProvider } from '@/components/chat/chat-message/chat-send-context';
import type { ConnectionState } from '@/hooks/use-agent-websocket';

interface ContextUsage {
  turns: number;
  contextUsed: number;
  outputTotal: number;
}

interface AgentChatAreaProps {
  sessionId: string | null;
  sessionTitle: string;
  showSessions: boolean;
  onShowSessions: () => void;
  messages: ChatMessageData[];
  isRunning: boolean;
  usage: ContextUsage;
  draftPrompt: string | null;
  isBuildingPrompt: boolean;
  editablePrompt: string;
  onEditablePromptChange: (value: string) => void;
  onCancelDraft: () => void;
  onStartFromPrompt: () => void;
  viewTab: ViewTab;
  setViewTab: (tab: ViewTab) => void;
  showChangesTab: boolean;
  diff: BranchDiff | null;
  diffLoading: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  isSessionOwner?: boolean;
  connectionState: ConnectionState;
  onReconnect: () => void;
  desktopConnected: boolean;
  relayTimedOut: boolean;
  onRetrySend: () => void;
  onRerun: () => void;
  onAfterFork: (newSessionDocumentId: string) => void;
  isTerminal: boolean;
}

export function AgentChatArea({
  sessionId,
  sessionTitle,
  showSessions,
  onShowSessions,
  messages,
  isRunning,
  usage,
  draftPrompt,
  isBuildingPrompt,
  editablePrompt,
  onEditablePromptChange,
  onCancelDraft,
  onStartFromPrompt,
  viewTab,
  setViewTab,
  showChangesTab,
  diff,
  diffLoading,
  onSend,
  onStop,
  isSessionOwner = true,
  connectionState,
  onReconnect,
  desktopConnected,
  relayTimedOut,
  onRetrySend,
  onRerun,
  onAfterFork,
  isTerminal,
}: AgentChatAreaProps) {
  const showDraftEditor = (draftPrompt || isBuildingPrompt) && !sessionId;
  const searchParams = useSearchParams();
  const highlightTurnId = searchParams?.get('turn') ?? null;

  // Arm once when state leaves 'open'; the connecting↔reconnecting flap during
  // an outage must not restart the 5s debounce, so the timer survives state
  // transitions and is only cleared on return-to-open or on unmount.
  const [showReconnectBanner, setShowReconnectBanner] = useState(false);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (connectionState === 'open') {
      if (bannerTimerRef.current) {
        clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = null;
      }
      setShowReconnectBanner(false);
      return;
    }
    if (bannerTimerRef.current === null) {
      bannerTimerRef.current = setTimeout(() => {
        setShowReconnectBanner(true);
        bannerTimerRef.current = null;
      }, 5000);
    }
  }, [connectionState]);
  useEffect(() => () => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
  }, []);

  return (
    <div className={cn(
      'flex-1 min-h-0 min-w-0 flex flex-col chat-prose',
      showSessions && 'hidden md:flex',
    )}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-surface-variant bg-surface px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onShowSessions}
            className="rounded p-2 text-primary-fixed hover:text-outline md:hidden shrink-0"
            aria-label="Show sessions"
          >
            <List className="h-4 w-4" />
          </button>
          <h3 className="text-sm font-semibold text-on-surface-variant truncate" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>
            {sessionTitle}
          </h3>
          <ConnectionPill state={connectionState} />
          {usage.turns > 0 && <ContextUsageBar usage={usage} />}
        </div>
        {sessionId && isTerminal && isSessionOwner && !isRunning && (
          <button
            onClick={onRerun}
            title="Rerun session"
            aria-label="Rerun session"
            className="rounded p-2 text-primary-fixed hover:text-outline shrink-0"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Body */}
      {showDraftEditor ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <PromptEditor
            isBuildingPrompt={isBuildingPrompt}
            draftPrompt={draftPrompt}
            editablePrompt={editablePrompt}
            onEditablePromptChange={onEditablePromptChange}
            onCancel={onCancelDraft}
            onStart={onStartFromPrompt}
          />
        </div>
      ) : (
        <>
          {showChangesTab && (
            <div className="flex border-b border-surface-variant bg-surface">
              <button
                onClick={() => setViewTab('chat')}
                className={`px-4 py-2 text-xs font-medium ${viewTab === 'chat' ? 'border-b-2 border-primary text-primary' : 'text-primary-fixed hover:text-outline'}`}
              >
                Chat
              </button>
              <button
                onClick={() => setViewTab('changes')}
                className={`px-4 py-2 text-xs font-medium ${viewTab === 'changes' ? 'border-b-2 border-primary text-primary' : 'text-primary-fixed hover:text-outline'}`}
              >
                Changes
                {diff && diff.files.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-surface-variant px-1.5 py-0.5 text-[10px]">
                    {diff.files.length}
                  </span>
                )}
              </button>
            </div>
          )}

          {viewTab === 'changes' && showChangesTab ? (
            diffLoading ? (
              <div className="flex flex-1 items-center justify-center p-4">
                <div className="text-sm text-primary-fixed animate-pulse">Loading changes...</div>
              </div>
            ) : (
              <BranchDiffSummary diff={diff} />
            )
          ) : (
            <>
              <ChatSendProvider send={onSend}>
              <ChatMessages
                messages={messages}
                sessionId={sessionId}
                highlightTurnId={highlightTurnId}
                onAfterFork={isSessionOwner ? onAfterFork : undefined}
              />
              </ChatSendProvider>
              {showReconnectBanner && connectionState !== 'open' && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center justify-between gap-3 border-t border-warning-dim/30 bg-surface-variant px-4 py-2 text-xs text-on-surface-variant shrink-0"
                >
                  <span>Connection lost — reconnecting…</span>
                  <button
                    type="button"
                    onClick={onReconnect}
                    aria-label="Retry connection now"
                    className="font-medium text-primary hover:underline focus:underline focus:outline-none"
                  >
                    Retry now
                  </button>
                </div>
              )}
              {!desktopConnected && (
                <div
                  role="status"
                  aria-live="polite"
                  data-testid="no-runner-banner"
                  className="flex items-center gap-3 border-t border-warning-dim/30 bg-surface-variant px-4 py-2 text-xs text-on-surface-variant shrink-0"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-warning-dim" aria-hidden />
                  <span>{NO_RUNNER_BANNER}</span>
                </div>
              )}
              {relayTimedOut && desktopConnected && (
                <div
                  role="alert"
                  data-testid="relay-timeout-bubble"
                  className="flex items-center justify-between gap-3 border-t border-danger/30 bg-surface-variant px-4 py-2 text-xs text-on-surface-variant shrink-0"
                >
                  <span>{RELAY_TIMEOUT_BUBBLE}</span>
                  <button
                    type="button"
                    onClick={onRetrySend}
                    className="font-medium text-primary hover:underline focus:underline focus:outline-none"
                  >
                    Retry
                  </button>
                </div>
              )}
              <ChatInput
                onSend={(text) => onSend(text)}
                isRunning={isRunning}
                onStop={isSessionOwner ? onStop : undefined}
                disabled={!isSessionOwner || !desktopConnected}
                disabledReason={isSessionOwner && !desktopConnected ? NO_RUNNER_TOOLTIP : undefined}
                allowAttachments={false}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

const NO_RUNNER_TOOLTIP = 'No runner online — install Forge desktop or check device status';
const NO_RUNNER_BANNER = 'No runner online. Sessions cannot start until a desktop runner connects.';
const RELAY_TIMEOUT_BUBBLE = 'Session not picked up by any runner.';

const CONNECTION_PILL_META: Record<ConnectionState, { dot: string; label: string; pulse: boolean }> = {
  open: { dot: 'bg-success', label: 'Online', pulse: false },
  connecting: { dot: 'bg-warning-dim', label: 'Connecting…', pulse: false },
  reconnecting: { dot: 'bg-warning-dim', label: 'Reconnecting…', pulse: true },
};

function ConnectionPill({ state }: { state: ConnectionState }) {
  const meta = CONNECTION_PILL_META[state];

  return (
    <span
      className="flex items-center gap-1 font-mono text-[10px] text-primary-fixed ml-2 shrink-0"
      title={meta.label}
    >
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          meta.dot,
          meta.pulse && 'animate-pulse',
        )}
      />
      <span className="hidden sm:inline">{meta.label}</span>
    </span>
  );
}

function ContextUsageBar({ usage }: { usage: ContextUsage }) {
  const pct = Math.min(100, Math.round((usage.contextUsed / CONTEXT_LIMIT) * 100));
  const remaining = Math.max(0, 100 - pct);
  const barColor = remaining < 15 ? 'bg-danger' : remaining < 40 ? 'bg-warning-dim/100' : 'bg-success';

  return (
    <span className="flex items-center gap-1.5 sm:gap-2 font-mono text-[10px] text-primary-fixed ml-2 shrink-0">
      <span className="hidden sm:inline">ctx:{formatTokens(usage.contextUsed)}</span>
      <span className="w-10 sm:w-16 h-1.5 rounded-full bg-surface-variant inline-block relative">
        <span className={`absolute inset-y-0 left-0 rounded-full ${barColor}`} style={{ width: `${remaining}%` }} />
      </span>
      <span className={remaining < 15 ? 'text-danger' : ''}>{remaining}%</span>
      <span className="hidden sm:inline">out:{formatTokens(usage.outputTotal)}</span>
    </span>
  );
}
