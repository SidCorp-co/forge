"use client";

// The shared conversation thread — renders flattened `ConversationItem[]`.
// Reused by the run thread (session-screen) and the /agent Chat surface.
// Prompt turns are editable + regen/fork anchors; agent turns render ordered
// text / tool / todos blocks with a streaming caret on the live tail.
import { useState } from "react";
import { Button, Icon, StreamingText } from "@/design";
import type { AgentTodo, ConversationItem } from "../types";
import { ToolCard } from "./tool-card";

export interface ConversationActions {
  onRegenerate: (turnId: string) => void;
  onFork: (turnId: string) => void;
  onEditTurn: (turnId: string, content: string, expectedEditedAt: string | null) => void;
}

interface ConversationProps extends ConversationActions {
  items: ConversationItem[];
  /** Session is live — drives the caret on the last agent turn. */
  streaming?: boolean;
  /** Turn actions are disabled while a turn is in flight. */
  busy?: boolean;
}

const TODO_ICON: Record<AgentTodo["status"], { name: "check" | "play" | "dot"; color: string }> = {
  completed: { name: "check", color: "var(--green-600)" },
  in_progress: { name: "play", color: "var(--accent)" },
  pending: { name: "dot", color: "var(--fg-subtle)" },
};

function TodoList({ todos }: { todos: AgentTodo[] }) {
  if (todos.length === 0) return null;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2">
      <p className="fg-caption mb-1.5">Task list</p>
      <ul className="space-y-1">
        {todos.map((t, i) => {
          const ic = TODO_ICON[t.status];
          return (
            <li key={`${t.content}-${i}`} className="flex items-start gap-2">
              <Icon name={ic.name} size={13} className="mt-0.5 flex-none" style={{ color: ic.color }} />
              <span
                className="fg-body-sm"
                style={{ textDecoration: t.status === "completed" ? "line-through" : undefined, color: t.status === "completed" ? "var(--fg-subtle)" : undefined }}
              >
                {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TurnActions({ item, busy, onRegenerate, onFork }: { item: ConversationItem; busy?: boolean } & Pick<ConversationActions, "onRegenerate" | "onFork">) {
  return (
    <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <Button variant="ghost" size="sm" icon="rerun" disabled={busy} onClick={() => onRegenerate(item.turnId)} className="min-h-11">
        Regenerate
      </Button>
      <Button variant="ghost" size="sm" icon="fork" disabled={busy} onClick={() => onFork(item.turnId)} className="min-h-11">
        Fork
      </Button>
    </div>
  );
}

function PromptTurn({ item, busy, onRegenerate, onFork, onEditTurn }: { item: ConversationItem; busy?: boolean } & ConversationActions) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  return (
    <div className="group flex flex-col items-end">
      <div className="max-w-[88%] rounded-lg rounded-br-sm bg-accent px-3.5 py-2.5 text-on-accent sm:max-w-[80%]">
        {editing ? (
          <div className="flex w-full flex-col gap-2" style={{ minWidth: 240 }}>
            <textarea
              className="w-full resize-y rounded-md bg-surface px-2.5 py-2 text-sm text-fg focus-visible:outline-none"
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex items-center justify-end gap-1.5">
              <Button variant="ghost" size="sm" className="min-h-11 text-on-accent" onClick={() => { setEditing(false); setDraft(item.text); }}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="min-h-11"
                disabled={busy || !draft.trim() || draft === item.text}
                onClick={() => { onEditTurn(item.turnId, draft.trim(), item.editedAt); setEditing(false); }}
              >
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p className="fg-body whitespace-pre-wrap text-on-accent">{item.text}</p>
        )}
      </div>
      {!editing && (
        <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDraft(item.text); setEditing(true); }} className="min-h-11">
            Edit
          </Button>
          <Button variant="ghost" size="sm" icon="rerun" disabled={busy} onClick={() => onRegenerate(item.turnId)} className="min-h-11">
            Regenerate
          </Button>
          <Button variant="ghost" size="sm" icon="fork" disabled={busy} onClick={() => onFork(item.turnId)} className="min-h-11">
            Fork
          </Button>
        </div>
      )}
    </div>
  );
}

function AgentTurn({ item, streamingTail, busy, onRegenerate, onFork }: { item: ConversationItem; streamingTail?: boolean; busy?: boolean } & Pick<ConversationActions, "onRegenerate" | "onFork">) {
  // The caret trails the LAST text block of the live tail turn.
  let lastTextIdx = -1;
  item.blocks.forEach((b, i) => {
    if (b.type === "text") lastTextIdx = i;
  });

  return (
    <div className="group flex flex-col items-start">
      <div className="flex w-full max-w-[92%] flex-col gap-2 sm:max-w-[85%]">
        {item.blocks.map((block, i) => {
          if (block.type === "text") {
            return <StreamingText key={i} text={block.text} streaming={streamingTail && i === lastTextIdx} />;
          }
          if (block.type === "todos") return <TodoList key={i} todos={block.todos} />;
          return <ToolCard key={block.tool.id ?? i} tool={block.tool} />;
        })}
      </div>
      <TurnActions item={item} busy={busy} onRegenerate={onRegenerate} onFork={onFork} />
    </div>
  );
}

export function Conversation({ items, streaming, busy, onRegenerate, onFork, onEditTurn }: ConversationProps) {
  let lastAgentIdx = -1;
  items.forEach((it, i) => {
    if (it.kind === "agent") lastAgentIdx = i;
  });

  return (
    <div className="flex flex-col gap-5">
      {items.map((item, i) =>
        item.kind === "prompt" ? (
          <PromptTurn key={item.id} item={item} busy={busy} onRegenerate={onRegenerate} onFork={onFork} onEditTurn={onEditTurn} />
        ) : (
          <AgentTurn
            key={item.id}
            item={item}
            streamingTail={streaming && i === lastAgentIdx}
            busy={busy}
            onRegenerate={onRegenerate}
            onFork={onFork}
          />
        ),
      )}
    </div>
  );
}
