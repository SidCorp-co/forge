"use client";

import { usePathname } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { Icon, IconButton, SecondaryRegion, SlideOver, useMediaQuery } from "@/design";
import { useProjectEcosystems } from "@/features/ecosystem/hooks";
import { useProjects } from "@/features/projects/hooks";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import type { ChatDockApi } from "@/features/chat-dock/dock";
import { DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, clampDockWidth, targetConversationId } from "@/features/chat-dock/dock-target";
import { BOARD_DOCK_WIDTH, BoardPanel } from "../board/board-panel";
import { useBoard } from "@/features/board/board-store";
import { useUiSnapshot } from "../ui-actions/use-ui-actions";
import { useConversation } from "../hooks";
import { ConversationChat } from "./conversation-chat";
import { ConversationList } from "./conversation-list";
import { DockOpening, WaitingOffer } from "./dock-opening";
import { StartConversation } from "./start-conversation";

/** What a person sees the dock called — the top-bar button, the dock title and its labels. */
export const DOCK_TITLE = "Ask Agent";

function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

/** The record a page is about, by key, when its last path segment is one (`/requirements/REQ-1`). */
export function pageSubjectKey(pathname: string | null): string | null {
  const last = decodeURIComponent((pathname ?? "").split("/").filter(Boolean).at(-1) ?? "");
  return /^[A-Z]+-\d+$/.test(last) ? last : null;
}

/** What the chip beside the composer reads: the room is about this page, another record, or the project. */
export function scopeLabel(subjectKey: string | null, pageKey: string | null): string {
  if (subjectKey && subjectKey === pageKey) return "This page";
  return subjectKey ?? "Project";
}

function ScopeChip({ label, title, ecosystem }: { label: string; title: string; ecosystem?: boolean }) {
  return (
    <span
      data-testid="scope-chip"
      title={title}
      className="fg-caption inline-flex max-w-[10rem] flex-none items-center gap-1 rounded-pill bg-sunken px-2 py-0.5 text-muted"
    >
      <Icon name={ecosystem ? "link" : "folder"} size={12} className="flex-none" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function RoomScopeChip({
  project,
  ecosystemId,
  subjectKey,
  pageKey,
}: {
  project: { id: string; name: string };
  ecosystemId: string | null;
  subjectKey: string | null;
  pageKey: string | null;
}) {
  const q = useProjectEcosystems(ecosystemId ? project.id : "");
  if (!ecosystemId) {
    const label = scopeLabel(subjectKey, pageKey);
    const about = subjectKey ? `about ${subjectKey}` : "about the whole project";
    return <ScopeChip label={label} title={`${label} · ${project.name}: this conversation is ${about}`} />;
  }
  const named = q.data?.memberships.find((m) => m.ecosystem?.id === ecosystemId)?.ecosystem?.name;
  const label = named ?? (q.isError ? "an ecosystem whose name could not be read" : "ecosystem");
  return <ScopeChip ecosystem label="Ecosystem" title={`${label} · from ${project.name}`} />;
}

/** What the full-screen panel's way back is called: the page underneath it. */
export function pageLabel(pathname: string | null): string {
  const parts = (pathname ?? "").split("/").filter(Boolean);
  if (parts[0] === "projects" && parts.length <= 2) return "Dashboard";
  const last = decodeURIComponent(parts.at(-1) ?? "");
  if (!last) return "Back";
  // a record key (REQ-1, ISS-63) is a name already; only a slug reads better as words
  if (/^[A-Z]+-\d+$/.test(last)) return last;
  return last.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function ChatDockBody({ dock, fullScreen }: { dock: ChatDockApi; fullScreen?: boolean }) {
  const pathname = usePathname();
  const pageKey = pageSubjectKey(pathname);
  const [listing, setListing] = useState(false);
  const board = useBoard();
  const projectsQ = useProjects();
  const target = dock.target;
  const conversationId = targetConversationId(target);
  const roomQ = useConversation(conversationId ?? undefined);
  const project =
    target && target.kind !== "people" ? projectsQ.data?.find((p) => p.id === target.projectId) : undefined;
  const ecosystemId =
    target?.kind === "room" ? (roomQ.data?.ecosystemId ?? null) : target?.kind === "draft" ? (target.ecosystemId ?? null) : null;
  const subjectKey = target?.kind === "room" ? (roomQ.data?.subjectKey ?? null) : null;

  const pick = useCallback(
    (t: Parameters<ChatDockApi["select"]>[0]) => {
      dock.select(t);
      setListing(false);
    },
    [dock],
  );

  const body = () => {
    if (listing) {
      return (
        <ConversationList
          projectId={dock.projectId}
          conversationId={conversationId}
          pageKey={pageKey}
          onSelect={pick}
        />
      );
    }
    if (!target || target.kind === "people") {
      return (
        <StartConversation onStarted={(id, projectId) => pick({ kind: "room", projectId, conversationId: id })} />
      );
    }
    if (target.kind === "latest") {
      return <DockOpening projectId={target.projectId} pageKey={pageKey} onResolved={dock.select} />;
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
          scopeChip={<RoomScopeChip project={project} ecosystemId={ecosystemId} subjectKey={subjectKey} pageKey={pageKey} />}
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
    <SecondaryRegion>
      <div className="flex h-full min-h-0 flex-col" data-testid="chat-dock-body">
        {fullScreen && (
          <div className="flex flex-none items-center border-b border-line px-3 py-2">
            <button
              type="button"
              onClick={dock.close}
              aria-label={`Back to ${pageLabel(pathname)}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-sunken px-2.5 text-[13px] font-semibold text-fg hover:bg-hover"
            >
              <span aria-hidden>←</span>
              {pageLabel(pathname)}
            </button>
          </div>
        )}
        <header className="flex flex-none items-center gap-1 border-b border-line bg-surface px-3 py-2">
          <h2 className="fg-body-sm min-w-0 flex-1 truncate font-semibold text-fg">
            {listing ? "Conversations" : DOCK_TITLE}
          </h2>
          <IconButton
            icon="history"
            size="sm"
            aria-label={listing ? "Back to the conversation" : "Past conversations"}
            title={listing ? "Back to the conversation" : "Past conversations"}
            aria-pressed={listing}
            onClick={() => setListing((v) => !v)}
          />
          <IconButton
            icon="plus"
            size="sm"
            aria-label="New conversation"
            title="New conversation"
            onClick={() => pick(dock.projectId ? { kind: "draft", projectId: dock.projectId } : { kind: "people" })}
          />
          {!fullScreen && (
            <IconButton
              icon="pin"
              size="sm"
              aria-pressed={dock.pinned}
              aria-label={dock.pinned ? "Unpin: close when you change page" : "Pin: keep open across pages"}
              title={dock.pinned ? "Pinned: stays open across pages" : "Pin to keep it open across pages"}
              className={dock.pinned ? "text-accent-text" : undefined}
              onClick={() => dock.setPinned(!dock.pinned)}
            />
          )}
          <IconButton icon="x" size="sm" aria-label={`Close ${DOCK_TITLE}`} title="Close" onClick={dock.close} />
        </header>
        {!listing && (target?.kind === "room" || target?.kind === "draft") && (
          <WaitingOffer projectId={target.projectId} openId={conversationId} onOpen={pick} />
        )}
        <div className="min-h-0 flex-1 overflow-hidden">{body()}</div>
      </div>
    </SecondaryRegion>
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
        <ChatDockBody dock={dock} fullScreen />
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
