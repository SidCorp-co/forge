"use client";


import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { RenderBlock } from "./types";

/**
 * Each block's disclosure identity in its turn, or nothing where a block has no disclosure.
 */
export function disclosureKeys(
  turnId: string,
  blocks: readonly RenderBlock[],
): (string | undefined)[] {
  let tools = 0;
  let pauses = 0;
  return blocks.map((b) => {
    if (b.type === "tool") {
      tools += 1;
      return `${turnId}:tool:${b.tool.id ?? `#${tools}`}`;
    }
    if (b.type === "thinking" && typeof b.text === "string" && b.text.length > 0) {
      pauses += 1;
      return `${turnId}:think:${pauses}`;
    }
    return undefined;
  });
}

export interface ThreadDisclosures {
  isOpen(key: string): boolean;
  toggle(key: string): void;
  /** Has the reader opened anything inside this turn, at any point in this thread's life? */
  touched(turnId: string): boolean;
  /**
   * Is the reader at the bottom of the thread right now?
   */
  atBottom: boolean;
}

const Ctx = createContext<ThreadDisclosures | null>(null);

/** The turn id a disclosure key belongs to. */
const turnOf = (key: string) => key.slice(0, key.indexOf(":"));

/**
 * One thread's disclosure state, mounted above its turns.
 */
export function DisclosureScope({
  children,
  atBottom = true,
}: {
  children: ReactNode;
  /** Whether the reader is at the bottom of this thread. Defaults to true, which is where a thread opens. */
  atBottom?: boolean;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set<string>());

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
    setTouched((prev) => (prev.has(turnOf(key)) ? prev : new Set(prev).add(turnOf(key))));
  }, []);

  const value = useMemo<ThreadDisclosures>(
    () => ({
      isOpen: (key) => open.has(key),
      toggle,
      touched: (turnId) => touched.has(turnId),
      atBottom,
    }),
    [open, touched, toggle, atBottom],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The thread's disclosure state where there is a scope, and nothing where there is not. */
export function useThreadDisclosures(): ThreadDisclosures | null {
  return useContext(Ctx);
}

export function useDisclosure(key?: string): readonly [boolean, () => void] {
  const thread = useThreadDisclosures();
  const [local, setLocal] = useState(false);
  const toggleLocal = useCallback(() => setLocal((v) => !v), []);
  const toggleShared = useCallback(() => {
    if (thread && key) thread.toggle(key);
  }, [thread, key]);
  return thread && key ? [thread.isOpen(key), toggleShared] : [local, toggleLocal];
}
