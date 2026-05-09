'use client';

import { memo, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Markdown } from '@/components/ui/markdown';
import { coreFileUrl } from '@/lib/api/client';
import type { ChatMessageData, ToolCallData } from './chat-message-types';
import { SingleToolCall } from './tool-call-group';
import { ToolCallGroup } from './tool-call-group';
import { TodoProgress } from './chat-message-todos';
import type { AgentTodo } from './chat-message-types';
import { useTypewriter } from './use-typewriter';
import { TurnActions } from './turn-actions';

interface ChatMessageProps {
  message: ChatMessageData;
  variant?: 'agent' | 'chat';
  sessionId?: string | null;
  onAfterEdit?: () => void;
  onAfterRegenerate?: () => void;
  onAfterFork?: (newSessionDocumentId: string) => void;
}

type GroupedItem =
  | { type: 'text'; text: string; key: number }
  | { type: 'tools'; tools: ToolCallData[]; key: number }
  | { type: 'todos'; todos: AgentTodo[]; key: number };

function ChatMessageImpl({
  message,
  variant = 'agent',
  sessionId = null,
  onAfterEdit,
  onAfterRegenerate,
  onAfterFork,
}: ChatMessageProps) {
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const displayContent = useTypewriter(message.content || '', message.isStreaming ?? false);

  const { hasBlocks, groupedBlocks } = useMemo(() => {
    const blocks = message.contentBlocks;
    const hasNonTodoBlocks = blocks && blocks.some((b) => b.type !== 'todos');
    const hasBlocks = !!(blocks && blocks.length > 0 && hasNonTodoBlocks);

    const groupedBlocks: GroupedItem[] = [];
    if (hasBlocks && blocks) {
      let pendingTools: ToolCallData[] = [];
      let keyCounter = 0;
      const flushTools = () => {
        if (pendingTools.length === 0) return;
        let i = 0;
        while (i < pendingTools.length) {
          const name = pendingTools[i].name;
          const group: ToolCallData[] = [];
          while (i < pendingTools.length && pendingTools[i].name === name) {
            group.push(pendingTools[i++]);
          }
          groupedBlocks.push({ type: 'tools', tools: group, key: keyCounter++ });
        }
        pendingTools = [];
      };
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.tool) {
          pendingTools.push(block.tool);
        } else if (block.type === 'todos') {
          flushTools();
          const prevIdx = groupedBlocks.findIndex((g) => g.type === 'todos');
          if (prevIdx >= 0) {
            groupedBlocks.splice(prevIdx, 1);
          }
          groupedBlocks.push({ type: 'todos', todos: block.todos, key: keyCounter++ });
        } else if (block.type === 'text' && block.text) {
          flushTools();
          groupedBlocks.push({ type: 'text', text: block.text, key: keyCounter++ });
        }
      }
      flushTools();
    }
    return { hasBlocks, groupedBlocks };
  }, [message.contentBlocks]);

  if (message.role === 'system') {
    return (
      <div className="text-xs text-on-surface-variant py-0.5" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>
        {message.content}
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <>
        <div
          className={`group ${variant === 'agent' ? 'border-t border-outline-variant/30 pt-3' : ''}`}
          data-turn-id={message.turnId ?? undefined}
        >
          <div className="flex items-start gap-2">
            <span className="font-mono text-sm text-on-surface select-none shrink-0">❯</span>
            <div className="min-w-0 flex-1">
              <Markdown theme="dark">{message.content}</Markdown>
              {message.attachments && message.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {message.attachments.map((a, i) => (
                    <img
                      key={i}
                      src={coreFileUrl(a.url)}
                      alt={a.name}
                      className="h-20 w-20 rounded-lg object-cover border border-outline-variant/30 cursor-zoom-in hover:border-outline transition-colors"
                      onClick={() => setPreviewImage({ url: coreFileUrl(a.url), name: a.name })}
                    />
                  ))}
                </div>
              )}
              <TurnActions
                message={message}
                sessionId={sessionId}
                onAfterEdit={onAfterEdit}
                onAfterRegenerate={onAfterRegenerate}
                onAfterFork={onAfterFork}
              />
            </div>
          </div>
        </div>
        {previewImage && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-on-primary/80 backdrop-blur-sm"
            onClick={() => setPreviewImage(null)}
          >
            <button
              className="absolute top-4 right-4 p-2 text-on-surface/70 hover:text-on-surface"
              onClick={() => setPreviewImage(null)}
            >
              <X className="h-6 w-6" />
            </button>
            <img
              src={previewImage.url}
              alt={previewImage.name}
              className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </>
    );
  }

  // Assistant render
  return (
    <div className="group" data-turn-id={message.turnId ?? undefined}>
      {hasBlocks ? (
        groupedBlocks.map((item) => {
          if (item.type === 'text') {
            return <Markdown key={item.key} theme="dark">{item.text}</Markdown>;
          }
          if (item.type === 'tools') {
            return item.tools.length === 1
              ? <SingleToolCall key={item.key} tc={item.tools[0]} />
              : <ToolCallGroup key={item.key} tools={item.tools} />;
          }
          if (item.type === 'todos') {
            return <TodoProgress key={item.key} todos={item.todos} />;
          }
          return null;
        })
      ) : (
        // Fallback for legacy messages without contentBlocks
        <>
          {message.toolCalls && message.toolCalls.length > 0 && (
            <ToolCallGroup tools={message.toolCalls} />
          )}
          {(() => {
            const todosBlocks = message.contentBlocks?.filter((b) => b.type === 'todos');
            const last = todosBlocks?.[todosBlocks.length - 1];
            return last && last.type === 'todos' ? <TodoProgress key="todos-last" todos={last.todos} /> : null;
          })()}
          {displayContent && (
            <Markdown theme="dark">{displayContent}</Markdown>
          )}
        </>
      )}
      {message.isStreaming && !displayContent && !message.toolCalls?.length && !hasBlocks && (
        <span className="animate-pulse text-sm text-on-surface-variant" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>Thinking...</span>
      )}
      {message.content && !message.isStreaming && (
        <TurnActions
          message={message}
          sessionId={sessionId}
          onAfterEdit={onAfterEdit}
          onAfterRegenerate={onAfterRegenerate}
          onAfterFork={onAfterFork}
        />
      )}
    </div>
  );
}

export const ChatMessage = memo(ChatMessageImpl);
