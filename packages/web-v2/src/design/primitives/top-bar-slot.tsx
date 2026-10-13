
import { createContext, use, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TopBarSlots {
  title: HTMLElement | null;
  actions: HTMLElement | null;
  setTitle: (el: HTMLElement | null) => void;
  setActions: (el: HTMLElement | null) => void;
}

const TopBarSlotContext = createContext<TopBarSlots | null>(null);

// a page names itself into the shell's top bar rather than drawing its own title row (owner, 2026-10-02): the bar is the one header, and the provider marks where one exists
export function TopBarSlotProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  return (
    <TopBarSlotContext value={{ title, actions, setTitle, setActions }}>{children}</TopBarSlotContext>
  );
}

/** The shell's side: refs for the two places in the bar a page can fill. */
export function useTopBarSlotTargets() {
  const ctx = use(TopBarSlotContext);
  return { titleRef: ctx?.setTitle, actionsRef: ctx?.setActions };
}

export function useInTopBar(): boolean {
  return use(TopBarSlotContext) !== null;
}

/** In place outside a shell; inside one, nothing until the bar mounts, so a title never flashes. */
export function useTopBarPortal(slot: "title" | "actions", node: ReactNode): ReactNode {
  const ctx = use(TopBarSlotContext);
  if (!ctx) return node;
  const target = ctx[slot];
  return target ? createPortal(node, target) : null;
}

/** A page's primary actions, shown in the top bar beside its title. */
export function TopBarActions({ children }: { children: ReactNode }) {
  return <>{useTopBarPortal("actions", children)}</>;
}

/** Titles and acts under it render in place, not in the shell's bar: a page sample inside a page (/dev/design). */
export function InPlaceTopBar({ children }: { children: ReactNode }) {
  return <TopBarSlotContext value={null}>{children}</TopBarSlotContext>;
}
