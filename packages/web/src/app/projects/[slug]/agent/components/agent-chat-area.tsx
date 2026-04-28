'use client';

import { Info, List } from 'lucide-react';
import { ChatMessages } from '@/components/chat/chat-messages';
import { ChatInput } from '@/components/chat/chat-input';
import { DiffSummary } from '@/components/chat/diff-summary';
import { PromptEditor } from './prompt-editor';
import { formatTokens, CONTEXT_LIMIT } from '@/lib/utils/format-tokens';
import { cn } from '@/lib/utils/cn';
import type { ViewTab } from '../hooks';
import { AGENT_INTERACTIVE_ENABLED, type BranchDiff } from '@/features/agent/api';
import type { ChatMessageData } from '@/components/chat/chat-message';
import { ChatSendProvider } from '@/components/chat/chat-message/chat-send-context';

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
}: AgentChatAreaProps) {
  const showDraftEditor = (draftPrompt || isBuildingPrompt) && !sessionId;

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
          {usage.turns > 0 && <ContextUsageBar usage={usage} />}
        </div>
      </div>

      {!AGENT_INTERACTIVE_ENABLED && (
        <div className="flex items-center gap-2 border-b border-warning-dim/30 bg-warning-dim/10 px-4 py-2 text-xs text-warning shrink-0">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span>Read-only session viewer. Start/send/abort coming v0.1.x.</span>
        </div>
      )}

      {/* Body */}
      {showDraftEditor && AGENT_INTERACTIVE_ENABLED ? (
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
              <DiffSummary diff={diff} />
            )
          ) : (
            <>
              <ChatSendProvider send={onSend}>
              <ChatMessages messages={messages} />
              </ChatSendProvider>
              {AGENT_INTERACTIVE_ENABLED && (
                <ChatInput
                  onSend={(text, _files) => onSend(text)}
                  isRunning={isRunning}
                  onStop={isSessionOwner ? onStop : undefined}
                  disabled={!isSessionOwner}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
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
