"use client";

// Shares a single `useSidebar()` instance across the workspace layout and any
// page that needs to drive it (ISS-714 focus mode). `usePersistedState` only
// cross-syncs across TABS (the `storage` event) — a second same-tab instance
// would read stale state, so pages that want to collapse the nav must consume
// this context rather than calling `useSidebar()` themselves.
import { createContext, useContext, type ReactNode } from "react";
import { useSidebar, type SidebarState } from "./sidebar";

const SidebarContext = createContext<SidebarState | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const sidebar = useSidebar();
  return <SidebarContext.Provider value={sidebar}>{children}</SidebarContext.Provider>;
}

export function useSidebarContext(): SidebarState {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebarContext must be used within a SidebarProvider");
  return ctx;
}
