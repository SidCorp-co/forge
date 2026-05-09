import { useState, useRef, useEffect, useMemo } from "react";
import type { ToolCall } from "@/lib/types";
import { EXPAND_BY_DEFAULT, MAX_TOOL_OUTPUT, getToolLabel } from "./chat-message-tools";
import { EditToolBody, WriteToolBody } from "./chat-message-diff";
import { AskUserQuestionBody } from "./ask-user-question";
import { TodoProgress } from "./chat-message-todos";

const INLINE_TOOLS = new Set(["TodoWrite", "AskUserQuestion", "Task"]);

export function DefaultToolBody({ tc }: { tc: ToolCall }) {
  const output = tc.output ?? "";
  const truncated = output.length > MAX_TOOL_OUTPUT;

  return (
    <div className="ml-4 mt-0.5 mb-1 space-y-1">
      {tc.input && (
        <pre className="max-h-32 overflow-auto rounded bg-[#0a0a0a] px-2 py-1 font-mono text-[11px] text-[#888888] border border-[#222222]">
          {JSON.stringify(tc.input, null, 2)}
        </pre>
      )}
      {tc.output !== undefined && (
        <pre className="max-h-32 overflow-auto rounded bg-[#0a0a0a] px-2 py-1 font-mono text-[11px] text-[#888888] border border-[#222222]">
          {truncated ? output.slice(0, MAX_TOOL_OUTPUT) + "\n… (truncated)" : output}
        </pre>
      )}
    </div>
  );
}

function renderToolBody(tc: ToolCall, expanded: boolean): React.ReactNode {
  if (!expanded) return null;
  switch (tc.name) {
    case "Edit":
      return <EditToolBody tc={tc} />;
    case "Write":
      return <WriteToolBody tc={tc} />;
    default:
      return <DefaultToolBody tc={tc} />;
  }
}

function TaskToolBody({ tc }: { tc: ToolCall }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const input = tc.input ?? {};
  const description = (input.description as string) ?? "";
  const subagentType = (input.subagent_type as string) ?? "";
  const prompt = (input.prompt as string) ?? "";
  const done = tc.output !== undefined;

  return (
    <div className="my-1.5 rounded border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 font-mono text-xs">
      <div className="flex items-center gap-2">
        <span className={done ? "text-green-500" : "text-blue-400 animate-pulse"}>
          {done ? "✓" : "⟳"}
        </span>
        {subagentType && (
          <span className="text-[#666666]">({subagentType})</span>
        )}
        <span className="font-medium text-[#cccccc]">{description || "Subtask"}</span>
      </div>
      {prompt && (
        <div className="mt-1.5">
          <button
            onClick={() => setShowPrompt((p) => !p)}
            className="text-[10px] text-[#555555] hover:text-[#888888]"
          >
            {showPrompt ? "▼ Hide prompt" : "▶ Show prompt"}
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

function TodoWriteBody({ tc }: { tc: ToolCall }) {
  const todos = (tc.input?.todos as { content: string; status: string }[]) ?? [];
  const mapped = todos.map((t) => ({
    content: t.content,
    status: t.status as "pending" | "in_progress" | "completed",
  }));
  return <TodoProgress todos={mapped} />;
}

export function SingleToolCall({ tc }: { tc: ToolCall }) {
  // Inline tools render without accordion chrome
  if (tc.name === "TodoWrite") return <TodoWriteBody tc={tc} />;
  if (tc.name === "AskUserQuestion") return <AskUserQuestionBody tc={tc} />;
  if (tc.name === "Task") return <TaskToolBody tc={tc} />;

  const isWriteOp = EXPAND_BY_DEFAULT.has(tc.name);
  const [expanded, setExpanded] = useState(isWriteOp);
  const done = tc.output !== undefined;
  const label = getToolLabel(tc);

  return (
    <div>
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left font-mono text-xs hover:bg-[#1a1a1a] rounded px-1 -mx-1"
      >
        <span className="text-[#666666] select-none">{expanded || done ? "⎿" : "⏵"}</span>
        <span className="text-[#cccccc]">{label}</span>
        {!isWriteOp && <span className="ml-auto text-[#444444] select-none">{expanded ? "▼" : "▶"}</span>}
      </button>
      {renderToolBody(tc, expanded)}
    </div>
  );
}

/** Group tools by name, preserving order of first appearance */
function groupByType(tools: ToolCall[]): { name: string; tools: ToolCall[] }[] {
  const map = new Map<string, ToolCall[]>();
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

function getCompletedCount(tools: ToolCall[]): number {
  return tools.filter((t) => t.output !== undefined).length;
}

function TypedToolSubGroup({ name, tools }: { name: string; tools: ToolCall[] }) {
  const isWriteOp = EXPAND_BY_DEFAULT.has(name);
  const [expanded, setExpanded] = useState(isWriteOp);
  const completed = getCompletedCount(tools);
  const allDone = completed === tools.length;

  // Single tool — render inline without sub-group nesting
  if (tools.length === 1) {
    return <SingleToolCall tc={tools[0]} />;
  }

  return (
    <div className="my-0.5">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1.5 font-mono text-xs hover:bg-[#1a1a1a] rounded px-1 -mx-1 py-0.5"
      >
        <span className="text-[#cccccc]">{allDone ? "✓" : "⏵"}</span>
        <span className="text-[#cccccc]">
          {tools.every((t) => t.name === tools[0].name)
            ? `${tools[0].name} (${tools.length})`
            : `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`}
        </span>
        <span className="text-[#666666]">
          {allDone ? "" : `(${completed}/${tools.length})`}
        </span>
        <span className="text-[#666666]">{expanded ? "▼" : "▶"}</span>
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

export function ToolCallGroup({ tools }: { tools: ToolCall[] }) {
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
    <>
      {inlineTools.map((tc) => (
        <SingleToolCall key={tc.id} tc={tc} />
      ))}
      {groupedTools.length > 0 && groups.length === 1 ? (
        <TypedToolSubGroup name={groups[0].name} tools={groups[0].tools} />
      ) : groupedTools.length > 0 ? (
        <div className="my-1">
          <button
            onClick={handleToggle}
            className="flex items-center gap-1.5 font-mono text-xs hover:bg-[#1a1a1a] rounded px-1 -mx-1 py-0.5"
          >
            <span className="text-[#cccccc]">{allDone ? "✓" : "⏵"}</span>
            <span className="text-[#cccccc]">{groupedTools.length} tool {groupedTools.length === 1 ? "call" : "calls"}</span>
            <span className="text-[#666666]">
              {allDone ? "" : `(${completed}/${groupedTools.length})`}
            </span>
            <span className="text-[#666666]">{expanded ? "▼" : "▶"}</span>
          </button>
          {expanded && (
            <div className="ml-3 border-l border-[#333333] pl-3 mt-0.5">
              {groups.map((g) => (
                <TypedToolSubGroup key={g.name} name={g.name} tools={g.tools} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
