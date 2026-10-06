"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { type AboutKind, aboutDraft } from "./ask-about";
import { type ChatTarget, clampDockWidth, defaultDockWidth, targetInScope } from "./dock-target";

export const DOCK_OPEN_ON_KEY = "web-v2:chat-dock-open-on";
export const DOCK_WIDTH_KEY = "web-v2:chat-dock-width";
export const DOCK_PINNED_KEY = "web-v2:chat-dock-pinned";

export interface ChatDockApi {
  projectId: string | null;
  open: boolean;
  /** Pinned, the dock stays open across navigation; unpinned, a new page closes it. */
  pinned: boolean;
  setPinned: (pinned: boolean) => void;
  target: ChatTarget | null;
  generation: number;
  width: number;
  setWidth: (w: number) => void;
  show: (target?: ChatTarget) => void;
  close: () => void;
  toggle: () => void;
  select: (target: ChatTarget) => void;
  follow: (conversationId: string) => void;
  askAbout: (kind: AboutKind, ref: string) => void;
  /** A page names the room Ask Agent opens on it (a requirement's BA assistant room); null clears it. */
  setDoor: (door: DockDoor | null) => void;
}

/** Resolves the target the dock opens on, when it is opened from the top bar on a page that set one.
 *  It reports its own failure to the person and resolves null; it never rejects. */
export type DockDoor = () => Promise<ChatTarget | null>;

const ChatDockContext = createContext<ChatDockApi | null>(null);

export function useChatDockState(projectId: string | null): ChatDockApi {
  const [openOn, setOpenOn] = usePersistedState<string | null>(DOCK_OPEN_ON_KEY, null, { syncTabs: false });
  const [storedWidth, setStoredWidth] = usePersistedState(DOCK_WIDTH_KEY, defaultDockWidth(), { syncTabs: false });
  const [pinned, setPinnedState] = usePersistedState(DOCK_PINNED_KEY, false, { syncTabs: false });
  const pathname = usePathname() ?? "";
  const [picked, setPicked] = useState<ChatTarget | null>(null);
  const [generation, setGeneration] = useState(0);
  const door = useRef<DockDoor | null>(null);
  const target = targetInScope(picked, projectId);

  // the dock remembers the page it was opened on, so a new page — reached in the app or loaded
  // afresh — finds it closed unless pinned (REQ-11 BC-8); a query change (a peek opening) is the same page
  const open = openOn !== null && (pinned || openOn === pathname);
  useEffect(() => {
    if (openOn !== null && !pinned && openOn !== pathname) setOpenOn(null);
  }, [openOn, pinned, pathname, setOpenOn]);
  const setOpen = useCallback(
    (next: boolean) => setOpenOn(next ? pathname : null),
    [pathname, setOpenOn],
  );
  const setPinned = useCallback(
    (next: boolean) => {
      setPinnedState(next);
      if (!next && open) setOpenOn(pathname);
    },
    [open, pathname, setOpenOn, setPinnedState],
  );

  const select = useCallback((t: ChatTarget) => {
    setPicked(t);
    setGeneration((g) => g + 1);
  }, []);
  const show = useCallback(
    (t?: ChatTarget) => {
      if (t) select(t);
      setOpen(true);
    },
    [select, setOpen],
  );
  const follow = useCallback(
    (conversationId: string) =>
      setPicked((prev) => {
        const scoped = targetInScope(prev, projectId);
        return scoped && scoped.kind === "draft" ? { kind: "room", projectId: scoped.projectId, conversationId } : prev;
      }),
    [projectId],
  );
  const askAbout = useCallback(
    (kind: AboutKind, ref: string) => {
      if (!projectId) return;
      show({ kind: "draft", projectId, draft: aboutDraft(kind, ref) });
    },
    [projectId, show],
  );

  return useMemo(
    () => ({
      projectId,
      open,
      pinned,
      setPinned,
      target,
      generation,
      width: clampDockWidth(storedWidth),
      setWidth: (w: number) => setStoredWidth(clampDockWidth(w)),
      show,
      close: () => setOpen(false),
      // opening from the top bar on a page that named a door lands in that page's room (the
      // requirement's BA assistant, ISS-58); a door that cannot open says so itself and answers null,
      // which leaves the dock on its own target
      toggle: () => {
        const opening = !open;
        setOpen(opening);
        if (opening && door.current) void door.current().then((t) => t && select(t));
      },
      select,
      follow,
      askAbout,
      setDoor: (d: DockDoor | null) => {
        door.current = d;
      },
    }),
    [projectId, open, pinned, setPinned, target, generation, storedWidth, setStoredWidth, show, setOpen, select, follow, askAbout],
  );
}

export function ChatDockProvider({ value, children }: { value: ChatDockApi; children: React.ReactNode }) {
  return <ChatDockContext.Provider value={value}>{children}</ChatDockContext.Provider>;
}

export function useChatDock(): ChatDockApi | null {
  return useContext(ChatDockContext);
}

/** Names this page's door for as long as the page is mounted. */
export function useChatDockDoor(door: DockDoor | null) {
  const dock = useChatDock();
  const setDoor = dock?.setDoor;
  useEffect(() => {
    if (!setDoor) return;
    setDoor(door);
    return () => setDoor(null);
  }, [setDoor, door]);
}
