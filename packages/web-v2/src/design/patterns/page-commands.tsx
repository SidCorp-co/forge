// A screen's secondary acts live in the ⌘K palette, not on its face (REQ-11 BC-22): a screen names
// them with `usePageCommands`, the workspace's palette lists them first under "This page", and the
// screen's NextAction carries a quiet "more" control that opens the palette while any are named.
// Outside a workspace (a test, /dev/design) nothing is collected and nothing breaks.

import { createContext, type ReactNode, use, useEffect, useRef, useState } from "react";
import type { Command } from "./command-palette";

interface PageCommandsStore {
  sources: ReadonlyMap<symbol, () => Command[]>;
  add: (id: symbol, read: () => Command[]) => void;
  remove: (id: symbol) => void;
  openPalette: (() => void) | null;
}

const PageCommandsContext = createContext<PageCommandsStore | null>(null);

export function PageCommandsProvider({ openPalette, children }: { openPalette?: () => void; children: ReactNode }) {
  const [sources, setSources] = useState<ReadonlyMap<symbol, () => Command[]>>(() => new Map());
  // made once: a screen's registration depends on these, so a new pair each draw would re-register forever
  const [acts] = useState(() => ({
    add: (id: symbol, read: () => Command[]) => setSources((m) => new Map(m).set(id, read)),
    remove: (id: symbol) =>
      setSources((m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      }),
  }));
  const store: PageCommandsStore = { sources, ...acts, openPalette: openPalette ?? null };
  return <PageCommandsContext value={store}>{children}</PageCommandsContext>;
}

/** What a command looks like to the palette: a change of words re-registers it, a new closure does not. */
const signature = (commands: Command[]) => commands.map((c) => `${c.label}\u0000${c.icon}\u0000${c.kbd ?? ""}`).join("\u0001");

/** Names the screen's secondary acts for the palette while the screen is drawn. */
export function usePageCommands(commands: Command[]): void {
  const store = use(PageCommandsContext);
  const latestRef = useRef(commands);
  useEffect(() => {
    latestRef.current = commands;
  });
  const sig = signature(commands);
  const add = store?.add;
  const remove = store?.remove;
  useEffect(() => {
    if (!add || !remove || sig === "") return;
    const id = Symbol("page-commands");
    add(id, () => latestRef.current.map((c) => ({ ...c, group: "page" as const })));
    return () => remove(id);
    // the words decide when the palette's list changes; the acts are read through the ref when run
  }, [add, remove, sig]);
}

/** Every act the drawn screens named, for the palette. */
export function usePageCommandList(): Command[] {
  const store = use(PageCommandsContext);
  return store ? [...store.sources.values()].flatMap((read) => read()) : [];
}

/** The palette's opener, while the drawn screen named any act for it. */
export function usePageCommandsOpener(): (() => void) | null {
  const store = use(PageCommandsContext);
  return store && store.sources.size > 0 ? store.openPalette : null;
}
