"use client";

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
