"use client";

// The shared conversation thread — renders flattened `ConversationItem[]`.
// Reused by the run thread (session-screen) and the /agent Chat surface.
// Prompt turns are editable + regen/fork anchors; agent turns render ordered
// thinking / text / tool / todos blocks with a streaming caret on the live tail.
import { useEffect, useRef, useState } from "react";
import { Button, Icon, StreamingText, Textarea } from "@/design";
import { AttachmentList } from "@/features/issues/components/attachment-list";
import { disclosureKeys, useThreadDisclosures } from "../disclosure";
import { foldTurn } from "../fold";
import { AGENT_COLUMN, USER_BUBBLE } from "../layout";
import type { AgentTodo, ConversationItem, RenderBlock } from "../types";
import { ThinkingLine } from "./thinking-line";
import { ToolCard } from "./tool-card";

export interface ConversationActions {
  onRegenerate?: ((turnId: string) => void) | undefined;
  onFork?: ((turnId: string) => void) | undefined;
  onEditTurn?:
    | ((turnId: string, content: string, expectedEditedAt: string | null) => void)
    | undefined;
}

interface ConversationProps extends ConversationActions {
  items: ConversationItem[];
  /** Session is live — drives the caret on the last agent turn. */
  streaming?: boolean;
  /** Turn actions are disabled while a turn is in flight. */
  busy?: boolean;
  /**
   * Read-only render (transcript from `agent_sessions.messages`, not per-turn
   * rows): hide per-turn Edit/Regenerate/Fork — those need real turn ids that
   * the messages fallback doesn't carry (ISS-348).
   */
  readOnly?: boolean;
  newestAgentId?: string;
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
      {onRegenerate && (
        <Button variant="ghost" size="sm" icon="rerun" disabled={busy} onClick={() => onRegenerate(item.turnId)} className="min-h-11">
          Regenerate
        </Button>
      )}
      {onFork && (
        <Button variant="ghost" size="sm" icon="fork" disabled={busy} onClick={() => onFork(item.turnId)} className="min-h-11">
          Fork
        </Button>
      )}
    </div>
  );
}

function PromptTurn({ item, busy, readOnly, onRegenerate, onFork, onEditTurn }: { item: ConversationItem; busy?: boolean; readOnly?: boolean } & ConversationActions) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  return (
    <div className="group flex flex-col items-end">
      <div className={`${USER_BUBBLE} rounded-lg rounded-br-sm bg-accent px-3.5 py-2.5 text-on-accent`}>
        {editing ? (
          <div className="flex w-full flex-col gap-2" style={{ minWidth: 240 }}>
            <Textarea
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
                onClick={() => { onEditTurn?.(item.turnId, draft.trim(), item.editedAt); setEditing(false); }}
              >
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p className="fg-body whitespace-pre-wrap text-on-accent">{item.text}</p>
        )}
      </div>
      {!editing && item.attachments.length > 0 && (
        <div className={`mt-2 flex justify-end ${USER_BUBBLE}`}>
          <AttachmentList rows={item.attachments} />
        </div>
      )}
      {!editing && !readOnly && (onEditTurn || onRegenerate || onFork) && (
        <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {onEditTurn && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDraft(item.text); setEditing(true); }} className="min-h-11">
              Edit
            </Button>
          )}
          {onRegenerate && (
            <Button variant="ghost" size="sm" icon="rerun" disabled={busy} onClick={() => onRegenerate(item.turnId)} className="min-h-11">
              Regenerate
            </Button>
          )}
          {onFork && (
            <Button variant="ghost" size="sm" icon="fork" disabled={busy} onClick={() => onFork(item.turnId)} className="min-h-11">
              Fork
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FoldRow({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-testid="turn-fold"
      aria-expanded={false}
      onClick={onOpen}
      className="flex w-fit items-center gap-1.5 rounded text-subtle hover:text-default"
      style={{ fontSize: "var(--text-12)" }}
    >
      <Icon name="chevronRight" size={12} className="flex-none" />
      <span>{label}</span>
    </button>
  );
}

function AgentTurn({ item, streamingTail, folded, busy, readOnly, onRegenerate, onFork }: { item: ConversationItem; streamingTail?: boolean; folded?: boolean; busy?: boolean; readOnly?: boolean } & Pick<ConversationActions, "onRegenerate" | "onFork">) {
  const tailIdx = item.blocks.length - 1;
  const caretIdx = item.blocks[tailIdx]?.type === "text" ? tailIdx : -1;

  const disclosures = useThreadDisclosures();
  const [unfolded, setUnfolded] = useState(false);

  const [latched, setLatched] = useState(
    () => folded === true && disclosures?.atBottom !== false,
  );
  const wasOld = useRef(folded === true);
  useEffect(() => {
    const old = folded === true;
    if (old && !wasOld.current && disclosures?.atBottom !== false) setLatched(true);
    if (!old && wasOld.current) setLatched(false);
    wasOld.current = old;
  }, [folded, disclosures?.atBottom]);
  const keys = disclosureKeys(item.id, item.blocks);

  const columnRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!unfolded) return;
    columnRef.current
      ?.querySelector<HTMLElement>(
        '[data-testid="tool-result-toggle"],[data-testid="thinking-line-toggle"]',
      )
      ?.focus();
  }, [unfolded]);
  const fold =
    latched && folded === true && !unfolded && disclosures?.touched(item.id) !== true
      ? foldTurn(item.blocks)
      : null;

  const renderBlock = (block: RenderBlock, i: number) => {
    if (block.type === "text") {
      return <StreamingText key={i} text={block.text} streaming={streamingTail && i === caretIdx} />;
    }
    if (block.type === "todos") return <TodoList key={i} todos={block.todos} />;
    if (block.type === "thinking") {
      return (
        <ThinkingLine
          key={i}
          text={block.text}
          durationMs={block.durationMs}
          count={block.count}
          streaming={streamingTail && i === item.blocks.length - 1}
          {...(keys[i] ? { blockKey: keys[i] } : {})}
        />
      );
    }
    return (
      <ToolCard
        key={block.tool.id ?? i}
        tool={block.tool}
        live={streamingTail}
        {...(keys[i] ? { blockKey: keys[i] } : {})}
      />
    );
  };

  return (
    <div className="group flex flex-col items-start" data-testid="agent-turn" data-turn-id={item.id}>
      <div ref={columnRef} className={`flex flex-col gap-2 ${AGENT_COLUMN}`}>
        {fold
          ? fold.rows.map((row) =>
              row.kind === "fold" ? (
                <FoldRow key="fold" label={row.label} onOpen={() => setUnfolded(true)} />
              ) : (
                renderBlock(row.block, row.index)
              ),
            )
          : item.blocks.map(renderBlock)}
      </div>
      {!readOnly && <TurnActions item={item} busy={busy} onRegenerate={onRegenerate} onFork={onFork} />}
    </div>
  );
}

export function Conversation({ items, streaming, busy, readOnly, newestAgentId, onRegenerate, onFork, onEditTurn }: ConversationProps) {
  let lastAgentIdx = -1;
  items.forEach((it, i) => {
    if (it.kind === "agent") lastAgentIdx = i;
  });
  const newest = newestAgentId ?? (lastAgentIdx >= 0 ? items[lastAgentIdx]?.id : undefined);

  return (
    <div className="flex flex-col gap-5">
      {items.map((item, i) =>
        item.kind === "prompt" ? (
          <PromptTurn key={item.id} item={item} busy={busy} readOnly={readOnly} onRegenerate={onRegenerate} onFork={onFork} onEditTurn={onEditTurn} />
        ) : (
          <AgentTurn
            key={item.id}
            item={item}
            streamingTail={streaming && i === lastAgentIdx}
            folded={newest !== undefined && item.id !== newest}
            busy={busy}
            readOnly={readOnly}
            onRegenerate={onRegenerate}
            onFork={onFork}
          />
        ),
      )}
    </div>
  );
}
