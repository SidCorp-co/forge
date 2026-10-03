"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { type AboutKind, aboutDraft } from "./ask-about";
import { type ChatTarget, DOCK_DEFAULT_WIDTH, clampDockWidth, targetInScope } from "./dock-target";

export const DOCK_OPEN_KEY = "web-v2:chat-dock-open";
export const DOCK_WIDTH_KEY = "web-v2:chat-dock-width";

export interface ChatDockApi {
  projectId: string | null;
  open: boolean;
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
  const [open, setOpen] = usePersistedState(DOCK_OPEN_KEY, false, { syncTabs: false });
  const [storedWidth, setStoredWidth] = usePersistedState(DOCK_WIDTH_KEY, DOCK_DEFAULT_WIDTH, { syncTabs: false });
  const [picked, setPicked] = useState<ChatTarget | null>(null);
  const [generation, setGeneration] = useState(0);
  const door = useRef<DockDoor | null>(null);
  const target = targetInScope(picked, projectId);

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
      target,
      generation,
      width: clampDockWidth(storedWidth),
      setWidth: (w: number) => setStoredWidth(clampDockWidth(w)),
      show,
      close: () => setOpen(false),
      // cm:why opening from the top bar on a page that named a door lands in that page's room (the
      // requirement's BA assistant, ISS-58); a door that cannot open says so itself and answers null,
      // which leaves the dock on its own target
      toggle: () => {
        const opening = !open;
        setOpen((o) => !o);
        if (opening && door.current) void door.current().then((t) => t && select(t));
      },
      select,
      follow,
      askAbout,
      setDoor: (d: DockDoor | null) => {
        door.current = d;
      },
    }),
    [projectId, open, target, generation, storedWidth, setStoredWidth, show, setOpen, select, follow, askAbout],
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
