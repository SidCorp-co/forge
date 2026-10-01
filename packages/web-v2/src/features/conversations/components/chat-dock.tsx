"use client";

import { useCallback, useRef, useState } from "react";
import { Icon, IconButton, Popover, SlideOver, useMediaQuery } from "@/design";
import { useProjectEcosystems } from "@/features/ecosystem/hooks";
import { useProjects } from "@/features/projects/hooks";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import type { ChatDockApi } from "../dock";
import { DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, clampDockWidth, targetConversationId } from "../dock-target";
import { BOARD_DOCK_WIDTH, BoardPanel } from "../board/board-panel";
import { useBoard } from "../board/board-store";
import { useUiSnapshot } from "../ui-actions/use-ui-actions";
import { useConversation } from "../hooks";
import { ConversationChat } from "./conversation-chat";
import { ConversationList } from "./conversation-list";
import { StartConversation } from "./start-conversation";

/** What a person sees the dock called — the top-bar button, the dock title and its labels. */
export const DOCK_TITLE = "Ask Agent";

function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

function ScopeChip({ name, ecosystem }: { name: string; ecosystem?: boolean }) {
  return (
    <span
      data-testid="scope-chip"
      className="fg-caption inline-flex max-w-[12rem] items-center gap-1 rounded-pill border border-line bg-sunken px-2 py-0.5 text-muted"
    >
      <Icon name={ecosystem ? "link" : "folder"} size={12} className="flex-none" />
      <span className="truncate">{name}</span>
    </span>
  );
}

function RoomScopeChip({ project, ecosystemId }: { project: { id: string; name: string }; ecosystemId: string | null }) {
  const q = useProjectEcosystems(ecosystemId ? project.id : "");
  if (!ecosystemId) return <ScopeChip name={project.name} />;
  const named = q.data?.memberships.find((m) => m.ecosystem?.id === ecosystemId)?.ecosystem?.name;
  const label = named ?? (q.isError ? "an ecosystem whose name could not be read" : "ecosystem");
  return <ScopeChip ecosystem name={`${label} · from ${project.name}`} />;
}

export function ChatDockBody({ dock }: { dock: ChatDockApi }) {
  const [history, setHistory] = useState(false);
  const historyAnchor = useRef<HTMLSpanElement>(null);
  const board = useBoard();
  const projectsQ = useProjects();
  const target = dock.target;
  const conversationId = targetConversationId(target);
  const roomQ = useConversation(conversationId ?? undefined);
  const project =
    target && target.kind !== "people" ? projectsQ.data?.find((p) => p.id === target.projectId) : undefined;
  const ecosystemId =
    target?.kind === "room" ? (roomQ.data?.ecosystemId ?? null) : target?.kind === "draft" ? (target.ecosystemId ?? null) : null;

  const pick = useCallback(
    (t: Parameters<ChatDockApi["select"]>[0]) => {
      dock.select(t);
      setHistory(false);
    },
    [dock],
  );

  const body = () => {
    if (!target || target.kind === "people") {
      return (
        <StartConversation onStarted={(id, projectId) => pick({ kind: "room", projectId, conversationId: id })} />
      );
    }
    if (!project) {
      return (
        <p className="fg-body-sm p-4 text-muted">
          {projectsQ.isLoading ? "Reading projects…" : "This chat's project is not one you can open."}
        </p>
      );
    }
    const chat = (
      <>
        <RoomSub projectId={project.id} />
        <ConversationChat
          key={`${dock.generation}:${target.kind === "draft" ? (target.draft ?? "") : ""}`}
          projectId={project.id}
          conversationId={conversationId ?? undefined}
          initialDraft={target.kind === "draft" ? target.draft : undefined}
          ecosystemId={ecosystemId}
          scopeChip={<RoomScopeChip project={project} ecosystemId={ecosystemId} />}
          onConversationActive={dock.follow}
        />
      </>
    );
    if (!board.open) return chat;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-[3]">
          <BoardForProject projectId={project.id} slug={project.slug} />
        </div>
        <div className="min-h-0 flex-[2] overflow-hidden">{chat}</div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-dock-body">
      <header className="flex flex-none items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="fg-body-sm min-w-0 flex-1 truncate font-semibold text-fg">{DOCK_TITLE}</h2>
        <span ref={historyAnchor} className="inline-flex">
          <IconButton
            icon="history"
            size="sm"
            aria-label="Past conversations"
            title="Past conversations"
            aria-expanded={history}
            onClick={() => setHistory((v) => !v)}
          />
        </span>
        <IconButton
          icon="plus"
          size="sm"
          aria-label="New conversation"
          title="New conversation"
          onClick={() => pick(dock.projectId ? { kind: "draft", projectId: dock.projectId } : { kind: "people" })}
        />
        <IconButton icon="x" size="sm" aria-label={`Close ${DOCK_TITLE}`} title="Close" onClick={dock.close} />
      </header>
      <Popover
        open={history}
        anchor={historyAnchor}
        onDismiss={() => setHistory(false)}
        placement="bottom-end"
        maxHeight={520}
        className="flex w-[360px] max-w-[calc(100vw-2rem)] flex-col p-3"
      >
        <ConversationList projectId={dock.projectId} conversationId={conversationId} onSelect={pick} />
      </Popover>
      <div className="min-h-0 flex-1 overflow-hidden">{body()}</div>
    </div>
  );
}

function BoardForProject({ projectId, slug }: { projectId: string; slug: string }) {
  const { snapshot } = useUiSnapshot(slug);
  return <BoardPanel projectId={projectId} issueKey={snapshot.issueKey} />;
}

function ResizeHandle({
  width,
  onDrag,
  onCommit,
}: {
  width: number;
  onDrag: (w: number | null) => void;
  onCommit: (w: number) => void;
}) {
  const dragging = useRef(false);
  const fromPointer = (e: React.PointerEvent) => clampDockWidth(window.innerWidth - e.clientX);
  return (
    <hr
      aria-orientation="vertical"
      aria-label={`Resize the ${DOCK_TITLE} panel`}
      aria-valuenow={width}
      aria-valuemin={DOCK_MIN_WIDTH}
      aria-valuemax={DOCK_MAX_WIDTH}
      tabIndex={0}
      data-testid="chat-dock-resize"
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const delta = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
        if (delta === 0) return;
        e.preventDefault();
        onCommit(clampDockWidth(width + delta));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragging.current) onDrag(fromPointer(e));
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        onDrag(null);
        onCommit(fromPointer(e));
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onDrag(null);
      }}
      title="Drag to resize"
      className="absolute left-0 top-0 z-10 m-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize touch-none border-0 bg-transparent transition-colors hover:bg-[color:var(--link)] focus-visible:bg-[color:var(--link)] focus-visible:outline-none"
    />
  );
}

export function ChatDock({ dock }: { dock: ChatDockApi }) {
  const docked = useMediaQuery("(min-width: 48rem)");
  const [live, setLive] = useState<number | null>(null);
  const board = useBoard();
  if (!dock.open) return null;
  if (!docked) {
    return (
      <SlideOver open onClose={dock.close} hideHeader fitBody width="min(100vw, 560px)">
        <ChatDockBody dock={dock} />
      </SlideOver>
    );
  }
  const width = live ?? (board.open ? Math.max(dock.width, clampDockWidth(BOARD_DOCK_WIDTH)) : dock.width);
  return (
    <aside
      aria-label={DOCK_TITLE}
      data-testid="chat-dock"
      className="relative hidden h-full flex-none flex-col border-l border-line bg-app md:flex"
      style={{ width }}
    >
      <ResizeHandle width={width} onDrag={setLive} onCommit={dock.setWidth} />
      <ChatDockBody dock={dock} />
    </aside>
  );
}
