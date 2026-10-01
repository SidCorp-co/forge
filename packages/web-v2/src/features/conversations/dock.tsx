"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
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
}

const ChatDockContext = createContext<ChatDockApi | null>(null);

export function useChatDockState(projectId: string | null): ChatDockApi {
  const [open, setOpen] = usePersistedState(DOCK_OPEN_KEY, false, { syncTabs: false });
  const [storedWidth, setStoredWidth] = usePersistedState(DOCK_WIDTH_KEY, DOCK_DEFAULT_WIDTH, { syncTabs: false });
  const [picked, setPicked] = useState<ChatTarget | null>(null);
  const [generation, setGeneration] = useState(0);
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
      toggle: () => setOpen((o) => !o),
      select,
      follow,
      askAbout,
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
