'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type { ToolCallData } from './chat-message-types';
import { getToolLabel } from './tool-label';
import { EditToolBody, WriteToolBody, DefaultToolBody } from './tool-bodies';
import { AskUserQuestionBody } from './ask-user-question';
import { TodoProgress } from './chat-message-todos';

const EXPAND_BY_DEFAULT = new Set(['Edit', 'Write']);
const INLINE_TOOLS = new Set(['TodoWrite', 'AskUserQuestion', 'Task']);

function TaskToolBody({ tc }: { tc: ToolCallData }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const input = tc.input ?? {};
  const description = (input.description as string) ?? '';
  const subagentType = (input.subagent_type as string) ?? '';
  const prompt = (input.prompt as string) ?? '';
  const done = tc.result !== undefined || !tc.isStreaming;

  return (
    <div className="my-1.5 rounded border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 font-mono text-xs">
      <div className="flex items-center gap-2">
        <span className={done ? 'text-success' : 'text-info animate-pulse'}>
          {done ? '✓' : '⟳'}
        </span>
        {subagentType && (
          <span className="text-[#666666]">({subagentType})</span>
        )}
        <span className="font-medium text-[#cccccc]">{description || 'Subtask'}</span>
      </div>
      {prompt && (
        <div className="mt-1.5">
          <button
            onClick={() => setShowPrompt((p) => !p)}
            className="text-[10px] text-[#555555] hover:text-[#888888]"
          >
            {showPrompt ? '▼ Hide prompt' : '▶ Show prompt'}
          </button>
          {showPrompt && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-[#0a0a0a] px-2 py-1.5 text-[11px] text-[#666666] border border-[#222222] whitespace-pre-wrap">
              {prompt}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function TodoWriteBody({ tc }: { tc: ToolCallData }) {
  const todos = (tc.input?.todos as { content: string; status: string; activeForm?: string }[]) ?? [];
  return (
    <TodoProgress
      todos={todos.map((t) => ({
        content: t.content,
        status: (t.status as 'pending' | 'in_progress' | 'completed') ?? 'pending',
        activeForm: t.activeForm,
      }))}
    />
  );
}

function renderToolBody(tc: ToolCallData, expanded: boolean): React.ReactNode {
  if (!expanded) return null;
  switch (tc.name) {
    case 'Edit':
      return <EditToolBody tc={tc} />;
    case 'Write':
      return <WriteToolBody tc={tc} />;
    case 'AskUserQuestion':
      return <AskUserQuestionBody tc={tc} />;
    default:
      return <DefaultToolBody tc={tc} />;
  }
}

export function SingleToolCall({ tc }: { tc: ToolCallData }) {
  // Inline tools render without tool call chrome
  if (tc.name === 'TodoWrite') return <TodoWriteBody tc={tc} />;
  if (tc.name === 'AskUserQuestion') return <AskUserQuestionBody tc={tc} />;
  if (tc.name === 'Task') return <TaskToolBody tc={tc} />;

  const isWriteOp = EXPAND_BY_DEFAULT.has(tc.name);
  const [expanded, setExpanded] = useState(isWriteOp);
  const done = tc.result !== undefined || !tc.isStreaming;
  const label = getToolLabel(tc);

  return (
    <div>
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left font-mono text-xs hover:bg-[#1a1a1a] rounded px-1 -mx-1"
      >
        <span className="text-[#666666] select-none">{expanded || done ? '⎿' : '⏵'}</span>
        <span className="text-[#cccccc]">{label}</span>
        {!isWriteOp && <span className="ml-auto text-[#444444] select-none">{expanded ? '▼' : '▶'}</span>}
      </button>
      {renderToolBody(tc, expanded)}
    </div>
  );
}

/** Group tools by name, preserving order of first appearance */
function groupByType(tools: ToolCallData[]): { name: string; tools: ToolCallData[] }[] {
  const map = new Map<string, ToolCallData[]>();
  const order: string[] = [];
  for (const tc of tools) {
    if (!map.has(tc.name)) {
      map.set(tc.name, []);
      order.push(tc.name);
    }
    map.get(tc.name)!.push(tc);
  }
  return order.map((name) => ({ name, tools: map.get(name)! }));
}

function getCompletedCount(tools: ToolCallData[]): number {
  return tools.filter((t) => t.result !== undefined || !t.isStreaming).length;
}

function TypedToolSubGroup({ name, tools }: { name: string; tools: ToolCallData[] }) {
  const isWriteOp = EXPAND_BY_DEFAULT.has(name);
  const [expanded, setExpanded] = useState(isWriteOp);
  const completed = getCompletedCount(tools);
  const allDone = completed === tools.length;

  // Single tool — render inline without sub-group nesting
  if (tools.length === 1) {
    return <SingleToolCall tc={tools[0]} />;
  }

  // Use tool type name if all tools are the same type, otherwise generic label
  const sameType = tools.every((t) => t.name === tools[0].name);
  const label = sameType
    ? `${tools[0].name} (${tools.length})`
    : `${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}`;

  return (
    <div className="my-0.5">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1.5 font-mono text-xs hover:bg-[#1a1a1a] rounded px-1 -mx-1 py-0.5"
      >
        <span className="text-[#cccccc]">{allDone ? '✓' : '⏵'}</span>
        <span className="text-[#cccccc]">{label}</span>
        <span className="text-[#666666]">
          {allDone ? '' : `(${completed}/${tools.length})`}
        </span>
        <span className="text-[#666666]">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="ml-3 border-l border-[#333333] pl-3 mt-0.5">
          {tools.map((tc) => (
            <SingleToolCall key={tc.id} tc={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolCallGroup({ tools }: { tools: ToolCallData[] }) {
  // Inline tools render outside the group accordion
  const inlineTools = tools.filter((t) => INLINE_TOOLS.has(t.name));
  const groupedTools = tools.filter((t) => !INLINE_TOOLS.has(t.name));

  const hasWriteOps = groupedTools.some((t) => EXPAND_BY_DEFAULT.has(t.name));
  const [expanded, setExpanded] = useState(false);
  const userToggled = useRef(false);
  const completed = getCompletedCount(groupedTools);
  const allDone = completed === groupedTools.length;

  useEffect(() => {
    if (!userToggled.current && hasWriteOps) setExpanded(true);
  }, [hasWriteOps]);

  const handleToggle = () => {
    userToggled.current = true;
    setExpanded((prev) => !prev);
  };

  const groups = useMemo(() => groupByType(groupedTools), [groupedTools]);

  return (
    <div className="my-1">
      {/* Inline tools render directly, not inside accordion */}
      {inlineTools.map((tc) => (
        <SingleToolCall key={tc.id} tc={tc} />
      ))}
      {/* Regular tools — single type skips outer wrapper */}
      {groupedTools.length > 0 && groups.length === 1 ? (
        <TypedToolSubGroup name={groups[0].name} tools={groups[0].tools} />
      ) : groupedTools.length > 0 ? (
        <>
          <button
            onClick={handleToggle}
            className="flex items-center gap-1.5 font-mono text-xs hover:bg-[#1a1a1a] rounded px-1 -mx-1 py-0.5"
          >
            <span className="text-[#cccccc]">{allDone ? '✓' : '⏵'}</span>
            <span className="text-[#cccccc]">{groupedTools.length} tool {groupedTools.length === 1 ? 'call' : 'calls'}</span>
            <span className="text-[#666666]">
              {allDone ? '' : `(${completed}/${groupedTools.length})`}
            </span>
            <span className="text-[#666666]">{expanded ? '▼' : '▶'}</span>
          </button>
          {expanded && (
            <div className="ml-3 border-l border-[#333333] pl-3 mt-0.5">
              {groups.map((g) => (
                <TypedToolSubGroup key={g.name} name={g.name} tools={g.tools} />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
