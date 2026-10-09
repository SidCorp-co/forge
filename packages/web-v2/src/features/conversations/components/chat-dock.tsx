"use client";

import { usePathname } from "next/navigation";
import { type RefObject, useCallback, useRef, useState } from "react";
import { Icon, IconButton, SecondaryRegion, SlideOver, useMediaQuery } from "@/design";
import { useProjectEcosystems } from "@/features/ecosystem/hooks";
import { useProjects } from "@/features/projects/hooks";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { type ChatDockApi, usePageRoom } from "@/features/chat-dock/dock";
import { type DockSize, dockSizes, dockWidth, nextSize, sizeAt, sizeFromDrag } from "@/features/chat-dock/dock-size";
import { isScopedRoom, targetConversationId } from "@/features/chat-dock/dock-target";
import { BOARD_DOCK_WIDTH, BoardPanel } from "../board/board-panel";
import { useBoard } from "@/features/board/board-store";
import { useUiSnapshot } from "../ui-actions/use-ui-actions";
import { useConversation } from "../hooks";
import { ConversationChat } from "./conversation-chat";
import { ConversationList } from "./conversation-list";
import { DockOpening, WaitingOffer } from "./dock-opening";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { StartConversation } from "./start-conversation";
import { SubjectScopeNotice } from "./subject-scope-notice";

/** What a person sees the dock called — the top-bar button, the dock title and its labels — in the interface language. */
export const dockTitle = (t: Copy) => t("nav.chat");

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
export function scopeLabel(subjectKey: string | null, pageKey: string | null, t: Copy): string {
  if (subjectKey && subjectKey === pageKey) return t("shell.dock.thisPage");
  return subjectKey ?? t("common.nav.project");
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
  const t = useCopy();
  if (!ecosystemId) {
    const label = scopeLabel(subjectKey, pageKey, t);
    const about = subjectKey ? t("shell.dock.aboutKey", { key: subjectKey }) : t("shell.dock.aboutProject");
    return <ScopeChip label={label} title={t("shell.dock.scopeTitle", { label, project: project.name, about })} />;
  }
  const named = q.data?.memberships.find((m) => m.ecosystem?.id === ecosystemId)?.ecosystem?.name;
  const label = named ?? (q.isError ? t("shell.dock.ecosystemUnread") : t("shell.dock.anEcosystem"));
  return <ScopeChip ecosystem label={t("nav.ecosystem")} title={t("shell.dock.ecosystemTitle", { label, project: project.name })} />;
}

/** What the full-screen panel's way back is called: the page underneath it. */
export function pageLabel(pathname: string | null, t: Copy): string {
  const parts = (pathname ?? "").split("/").filter(Boolean);
  if (parts[0] === "projects" && parts.length <= 2) return t("nav.proj-overview");
  const last = decodeURIComponent(parts.at(-1) ?? "");
  if (!last) return t("shell.dock.back");
  // a record key (REQ-1, ISS-63) is a name already; only a slug reads better as words
  if (/^[A-Z]+-\d+$/.test(last)) return last;
  return last.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function ChatDockBody({ dock, fullScreen, sizeControl }: { dock: ChatDockApi; fullScreen?: boolean; sizeControl?: React.ReactNode }) {
  const pathname = usePathname();
  const pageKey = pageSubjectKey(pathname);
  const t = useCopy();
  const title = dockTitle(t);
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
          {projectsQ.isLoading ? t("shell.dock.readingProjects") : t("shell.dock.projectClosed")}
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
      <div className="@container flex h-full min-h-0 flex-col" data-testid="chat-dock-body">
        {fullScreen && (
          <div className="flex flex-none items-center border-b border-line px-3 py-2">
            <button
              type="button"
              onClick={dock.close}
              aria-label={pageLabel(pathname, t) === t("shell.dock.back") ? t("shell.dock.back") : t("common.backTo", { label: pageLabel(pathname, t) })}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-sunken px-2.5 text-[13px] font-semibold text-fg hover:bg-hover"
            >
              <span aria-hidden>←</span>
              {pageLabel(pathname, t)}
            </button>
          </div>
        )}
        {/* under a 24rem panel the header takes two rows: the title with pin and close, then the rest,
            so the title and every control stay inside the narrowest panel (half of the 360px floor) */}
        <header data-testid="chat-dock-header" className="flex flex-none flex-wrap items-center gap-1 border-b border-line bg-surface px-3 py-2">
          <h2 className="fg-body-sm min-w-0 flex-[1_0_auto] truncate font-semibold text-fg">
            {listing ? t("shell.dock.conversations") : title}
          </h2>
          <div className="ml-auto flex min-w-0 flex-none items-center gap-1 @max-sm:order-last @max-sm:basis-full @max-sm:flex-wrap @max-sm:justify-end">
            <IconButton
              icon="history"
              size="sm"
              aria-label={listing ? t("shell.dock.backToConversation") : t("shell.dock.past")}
              title={listing ? t("shell.dock.backToConversation") : t("shell.dock.past")}
              aria-pressed={listing}
              onClick={() => setListing((v) => !v)}
            />
            <IconButton
              icon="plus"
              size="sm"
              aria-label={t("shell.dock.newConversation")}
              title={t("shell.dock.newConversation")}
              onClick={() => pick(dock.projectId ? { kind: "draft", projectId: dock.projectId } : { kind: "people" })}
            />
            {!fullScreen && sizeControl}
          </div>
          <div className="ml-auto flex flex-none items-center gap-1">
            {!fullScreen && (
              <IconButton
                icon="pin"
                size="sm"
                aria-pressed={dock.pinned}
                aria-label={dock.pinned ? t("shell.dock.unpinLabel") : t("shell.dock.pinLabel")}
                title={dock.pinned ? t("shell.dock.pinnedTitle") : t("shell.dock.pinTitle")}
                className={dock.pinned ? "text-accent-text" : undefined}
                onClick={() => dock.setPinned(!dock.pinned)}
              />
            )}
            <IconButton icon="x" size="sm" aria-label={t("shell.dock.close", { title })} title={t("shell.dock.closeShort")} onClick={dock.close} />
          </div>
        </header>
        {!listing && (target?.kind === "room" || target?.kind === "draft") && (
          <WaitingOffer projectId={target.projectId} openId={conversationId} onOpen={pick} />
        )}
        {!listing && target?.kind === "room" && roomQ.data && isScopedRoom(roomQ.data) && (
          <SubjectScopeNotice
            kind={roomQ.data.kind ?? null}
            subjectKey={roomQ.data.subjectKey ?? null}
            onAskProject={() => pick({ kind: "draft", projectId: target.projectId })}
          />
        )}
        <div className="min-h-0 flex-1 overflow-hidden">{body()}</div>
      </div>
    </SecondaryRegion>
  );
}

function BoardForProject({ projectId, slug }: { projectId: string; slug: string }) {
  const { snapshot } = useUiSnapshot(slug);
  return <BoardPanel projectId={projectId} issueKey={snapshot.item?.kind === "issue" ? snapshot.item.key : undefined} />;
}

function Segment({ on, size, children }: { on: boolean; size: string; children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      data-segment={size}
      data-on={on || undefined}
      className={`whitespace-nowrap rounded px-1.5 py-0.5 ${on ? "bg-surface text-fg shadow-sm" : "text-muted"}`}
    >
      {children}
    </span>
  );
}

/**
 * One switch between the two sizes, both on it and the one the panel is at marked; a width between them
 * is marked between them, named for what set it. A click moves it to the other size, or snaps a width
 * between to the nearer (REQ-31 BC-2, BC-6). `byBoard`: the width is the one an open board widened it to.
 */
function SizeControl({ width, room, byBoard, onSize }: { width: number; room: number; byBoard: boolean; onSize: (size: DockSize) => void }) {
  const t = useCopy();
  const at = sizeAt(width, room);
  const next = nextSize(width, room);
  const between = byBoard ? t("shell.dock.size.board", { width }) : t("shell.dock.size.custom", { width });
  const shown = at === "large" ? t("shell.dock.size.large") : at === "half" ? t("shell.dock.size.half") : between;
  const label = t(next === "half" ? "shell.dock.size.toHalf" : "shell.dock.size.toLarge", { size: shown });
  return (
    <button
      type="button"
      data-testid="chat-dock-size"
      data-size={at ?? (byBoard ? "board" : "custom")}
      aria-label={label}
      title={label}
      onClick={() => onSize(next)}
      className="fg-caption inline-flex h-7 min-w-0 flex-none cursor-pointer items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5 font-semibold hover:border-[color:var(--link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--link)]"
    >
      <Segment on={at === "half"} size="half">
        {t("shell.dock.size.half")}
      </Segment>
      {at === null && (
        <Segment on size={byBoard ? "board" : "custom"}>
          <span className="@max-md:hidden">{between}</span>
          <span className="hidden @max-md:inline">{byBoard ? t("shell.dock.size.boardShort") : t("shell.dock.size.customShort")}</span>
        </Segment>
      )}
      <Segment on={at === "large"} size="large">
        {t("shell.dock.size.large")}
      </Segment>
    </button>
  );
}

function ResizeHandle({
  width,
  room,
  onDrag,
  onCommit,
}: {
  width: number;
  room: number;
  onDrag: (w: number | null) => void;
  onCommit: (size: DockSize) => void;
}) {
  const dragging = useRef(false);
  const t = useCopy();
  const { large, half } = dockSizes(room);
  const held = (px: number) => dockWidth(sizeFromDrag(px, room), room);
  const fromPointer = (e: React.PointerEvent) => window.innerWidth - e.clientX;
  return (
    <hr
      aria-orientation="vertical"
      aria-label={t("shell.dock.resize", { title: dockTitle(t) })}
      aria-valuenow={width}
      aria-valuemin={half}
      aria-valuemax={large}
      tabIndex={0}
      data-testid="chat-dock-resize"
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const delta = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
        if (delta === 0) return;
        e.preventDefault();
        onCommit(sizeFromDrag(width + delta, room));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragging.current) onDrag(held(fromPointer(e)));
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        onDrag(null);
        onCommit(sizeFromDrag(fromPointer(e), room));
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onDrag(null);
      }}
      title={t("shell.dock.drag")}
      className="absolute left-0 top-0 z-10 m-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize touch-none border-0 bg-transparent transition-colors hover:bg-[color:var(--link)] focus-visible:bg-[color:var(--link)] focus-visible:outline-none"
    />
  );
}

/** The panel beside the page. `page` is the page column: the panel and the page share the width from its left edge to the window's right. */
export function ChatDock({ dock, page }: { dock: ChatDockApi; page: RefObject<HTMLElement | null> }) {
  const docked = useMediaQuery("(min-width: 48rem)");
  const room = usePageRoom(page);
  const [live, setLive] = useState<number | null>(null);
  const board = useBoard();
  // a size picked while a board is open is drawn at once and kept; the board widens the panel only until then
  const [pickedOverBoard, setPickedOverBoard] = useState(false);
  if (pickedOverBoard && !board.open) setPickedOverBoard(false);
  const t = useCopy();
  if (!dock.open) return null;
  if (!docked) {
    return (
      <SlideOver open onClose={dock.close} hideHeader fitBody width="min(100vw, 560px)">
        <ChatDockBody dock={dock} fullScreen />
      </SlideOver>
    );
  }
  const kept = dockWidth(dock.size, room);
  // a board open in the conversation widens the panel to the board, never past large
  const widened = board.open && !pickedOverBoard ? Math.max(kept, dockWidth(BOARD_DOCK_WIDTH, room)) : kept;
  const width = live ?? widened;
  const pick = (size: DockSize) => {
    if (board.open) setPickedOverBoard(true);
    dock.setSize(size);
  };
  return (
    <aside
      aria-label={dockTitle(t)}
      data-testid="chat-dock"
      className="relative hidden h-full flex-none flex-col border-l border-line bg-app md:flex"
      style={{ width }}
    >
      <ResizeHandle width={width} room={room} onDrag={setLive} onCommit={pick} />
      <ChatDockBody
        dock={dock}
        sizeControl={<SizeControl width={width} room={room} byBoard={live === null && widened !== kept} onSize={pick} />}
      />
    </aside>
  );
}
