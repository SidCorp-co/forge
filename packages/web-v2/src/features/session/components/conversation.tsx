"use client";

// The shared conversation thread — renders flattened `ConversationItem[]`.
// Reused by the run thread (session-screen) and the /agent Chat surface.
// Prompt turns are editable + regen/fork anchors; agent turns render ordered
// thinking / text / tool / todos blocks with a streaming caret on the live tail.
import { useEffect, useRef, useState } from "react";
import { Button, Icon, StreamingText } from "@/design";
import { AttachmentList } from "@/features/issues/components/attachment-list";
import { disclosureKeys, useThreadDisclosures } from "../disclosure";
import { foldTurn } from "../fold";
import { AGENT_COLUMN, USER_BUBBLE } from "../layout";
import type { AgentTodo, ConversationItem, RenderBlock } from "../types";
import { ThinkingLine } from "./thinking-line";
import { ToolCard } from "./tool-card";

/**
 * The per-turn verbs, all three optional.
 */
// cm:guard optional because a conversation has none of them and never will: a run's turns can be
// edited, regenerated and forked, and an append-only conversation's cannot — `conversation-chat.tsx`
// states why ISS-1004 left all six run-shaped verbs on the session surface. Before ISS-1078 these
// were required, so the one other caller would have had to pass three no-op functions to render a
// thread, and a no-op handler behind a visible button is a control that silently does nothing. The
// row they live in is rendered only where a handler exists (ISS-1078).
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
  /**
   * The thread's newest agent turn. Every agent turn above it folds its machinery to one row.
   */
  // cm:guard the CALLER names it, because on the chat surface this component is mounted once per
  // turn — `conversation-thread.tsx:AssistantTurn` renders a `Conversation` holding a single item —
  // so an instance's own last item is the newest turn it can see and not the newest turn there is.
  // Left to work it out for itself, nothing on that surface would ever fold. Where the caller holds
  // the whole thread, as the session screen does, it may leave this alone and the last agent item
  // is the answer.
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
            <textarea
              className="w-full resize-y rounded-md bg-surface px-2.5 py-2 text-base text-fg focus-visible:outline-none md:text-sm"
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

/**
 * The one row a folded turn shows in place of everything it collapsed.
 */
// cm:guard the same affordance a collapsed pause uses, deliberately: a reader who has learned that a
// chevron and a grey line open onto more has learned it for both, and a second visual language for
// "there is more behind this" is how a thread stops being scannable.
function FoldRow({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-testid="turn-fold"
      aria-expanded={false}
      onClick={onOpen}
      className="flex w-fit items-center gap-1.5 rounded text-subtle hover:text-default"
      style={{ fontSize: 12 }}
    >
      <Icon name="chevronRight" size={12} className="flex-none" />
      <span>{label}</span>
    </button>
  );
}

function AgentTurn({ item, streamingTail, folded, busy, readOnly, onRegenerate, onFork }: { item: ConversationItem; streamingTail?: boolean; folded?: boolean; busy?: boolean; readOnly?: boolean } & Pick<ConversationActions, "onRegenerate" | "onFork">) {
  // cm:guard the caret trails the text block that is still GROWING, which — because a turn is
  // append-only — is the last block of the turn or none at all. It used to trail the last TEXT
  // block by index whatever came after it, so a turn that wrote a sentence and then called a tool
  // left a cursor blinking at the end of that sentence for the whole of the call, above a card
  // saying the call was still out (ISS-1083 criterion 18).
  // cm:why this is the same tail read `turn-stage.ts:turnStageOf` makes, and deliberately so: the
  // caret is on the prose exactly when the turn's stage line says `Responding…`, so the two cannot
  // disagree about whether anything is being written.
  const tailIdx = item.blocks.length - 1;
  const caretIdx = item.blocks[tailIdx]?.type === "text" ? tailIdx : -1;

  // cm:guard a turn a reader has opened anything inside NEVER folds, and the flag outlives the card
  // they opened (`disclosure.tsx`): folding the turn the moment they close it would take away what
  // they were in the middle of reading, and their own click would be what did it (criterion 25).
  // cm:why the fold row's own open state is local while the cards' is not: a turn is only ever
  // folded long after it settled, and the settle is the one moment this subtree is swapped out from
  // under a reader. There is nothing for it to survive.
  const disclosures = useThreadDisclosures();
  const [unfolded, setUnfolded] = useState(false);

  // cm:guard a turn folds ONLY at the moment it stops being the newest, and only if the reader was
  // at the bottom of the thread then. Both halves answer the implementation consult's F2: a reader
  // can be inside the turn that folds, below its cards, and then the height that vanishes is ABOVE
  // them and what they are reading moves. A reader who IS at the bottom is held there by the
  // browser's own clamp when content above them shrinks, so that case moves nothing — which is why
  // this is a gate and not a line of scroll arithmetic.
  // cm:guard latched, and never re-read: folding on `atBottom` as it changes would UNFOLD every old
  // turn the moment a reader scrolled up, which is the same defect with the sign flipped and every
  // turn in the thread moving at once instead of one.
  const [latched, setLatched] = useState(
    () => folded === true && disclosures?.atBottom !== false,
  );
  // cm:guard the latch is RELEASED when a turn becomes the newest again, which is not a hypothetical:
  // regenerating or editing a turn drops the ones after it, and on the chat surface an optimistic
  // entry can vanish. Without the release, a turn that had already folded once folded again the
  // moment a replacement arrived — with the reader anywhere at all, because its permission was the
  // one it captured minutes earlier (scroll consult F1).
  const wasOld = useRef(folded === true);
  useEffect(() => {
    const old = folded === true;
    if (old && !wasOld.current && disclosures?.atBottom !== false) setLatched(true);
    if (!old && wasOld.current) setLatched(false);
    wasOld.current = old;
  }, [folded, disclosures?.atBottom]);
  const keys = disclosureKeys(item.id, item.blocks);

  // cm:guard focus MOVES into what the row revealed, because opening it REMOVES the control that
  // was focused: a keyboard user who activated the row and was left on `document.body` has lost
  // their place in the thread rather than continuing through the cards they just asked for
  // (implementation consult F3).
  // cm:why nothing is focused where nothing revealed is interactive — a turn whose every card and
  // pause opens onto nothing renders static lines — and that limit is stated rather than answered
  // with a `tabIndex={-1}` container: there is nothing there to continue through, and a focus ring
  // around a whole turn says there is.
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

  // cm:guard ONE renderer for both paths, and the keys are the block's own: a kept block is the
  // SAME React element before and after its turn folds, so folding cannot remount the prose a
  // reader is looking at (criterion 29, asserted as node identity in `conversation-fold.test.tsx`).
  const renderBlock = (block: RenderBlock, i: number) => {
    if (block.type === "text") {
      return <StreamingText key={i} text={block.text} streaming={streamingTail && i === caretIdx} />;
    }
    if (block.type === "todos") return <TodoList key={i} todos={block.todos} />;
    // cm:guard this arm is before the `ToolCard` fall-through and must stay there: the function
    // ends by reading `block.tool` off whatever is left, so a block type with no arm reads a
    // field off undefined rather than rendering nothing. The compiler caught exactly that the
    // moment `RenderBlock` grew this member (ISS-1079).
    if (block.type === "thinking") {
      return (
        // cm:why the index IS this block's identity: a turn's blocks are positional and
        // append-only — the list grows at the end while the turn streams and never reorders — and a
        // thinking block carries no id to key on. The sibling text and todos arms key the same way
        // for the same reason. This used to need a `biome-ignore` for `noArrayIndexKey`; moving the
        // arms into a named function took the rule out of scope, and the suppression with it, so
        // what is left is the reason rather than the waiver (ISS-1083).
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
    // cm:why the turn carries its own id on the element: it is what lets a test name ONE turn in a
    // thread and assert that folding did not touch it — criterion 29 is a statement about the turns
    // a reader is not looking at, and there is no way to hold it without being able to point at one.
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
  // cm:guard the newest agent turn never folds, which is the owner's decision and criterion 21: a
  // reader who has just watched an answer arrive must not have it rearrange itself under them.
  // cm:why folding can only ever happen at the BOTTOM of a thread, and that is what holds criterion
  // 29 without a line of scroll arithmetic: exactly one turn stops being the newest each time a
  // newer one appears, every turn above it folded at its own transition, and content shrinking
  // below a reader's viewport does not move what is in it.
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
