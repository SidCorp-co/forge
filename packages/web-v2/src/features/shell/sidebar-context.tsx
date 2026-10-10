"use client";

import { createContext, use, type ReactNode } from "react";
import { useSidebar, type SidebarState } from "./sidebar";

const SidebarContext = createContext<SidebarState | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const sidebar = useSidebar();
  return <SidebarContext value={sidebar}>{children}</SidebarContext>;
}

export function useSidebarContext(): SidebarState {
  const ctx = use(SidebarContext);
  if (!ctx) throw new Error("useSidebarContext must be used within a SidebarProvider");
  return ctx;
}
