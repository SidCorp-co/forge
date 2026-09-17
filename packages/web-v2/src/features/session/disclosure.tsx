"use client";

// Which of a thread's disclosures a reader has opened, held ABOVE the turns (ISS-1083).
//
// cm:guard this cannot live in the leaf that draws the chevron, and the reason is a component
// SWAP rather than a re-render: when a turn settles on the chat surface, `threadEntries` stops
// emitting its `progress` entry and emits a `said` row instead, so React unmounts `LiveTurn` and
// mounts `Said` in its place. A tool result a reader had opened while the answer was arriving was
// discarded at that moment — criterion 24 — and no key inside the turn survives it, because the
// component at that position changes type. A scope mounted once per thread does survive it.
//
// cm:guard the key is `${turnId}:${kind}:${n}` and the turn id is the ENTRY id, which is the one
// thing that is the same on both sides of that swap: `ConversationProgressEntry.entry` carries "the
// id the settled row will carry", and `parseMessages` passes `entry.id` straight through as the
// item's own id. Keyed by anything else — a position in the thread, a React index — a reader's open
// card would jump to a different turn the moment a row landed above it. Why the suffix is not a
// block index either: `disclosureKeys` below.
//
// cm:guard `touched` is never cleared, and that IS criterion 25: a turn a reader has been inside
// keeps its machinery for as long as the thread is open. Folding a turn the moment they close the
// one card they opened would take away what they were in the middle of reading, and their own click
// would be what did it.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { RenderBlock } from "./types";

/**
 * Each block's disclosure identity in its turn, or nothing where a block has no disclosure.
 */
// cm:guard NOT the block's index, and this is the finding that named why (implementation consult
// F1): `assistantBlocks` is not append-only. `dedupeTodos` drops every task list but the last, so a
// second one arriving shifts every block after the first one down — and `withPauseCount` PREPENDS a
// pause block, which shifts all of them. Keyed by index, a reader's open tool result closed itself
// and the card below it inherited the open key, on a turn where nothing about either card had
// changed.
//
// cm:why counting within a KIND is what survives both: a tool call carries its own id on every
// producer, and where one is missing its ordinal among tools is unmoved by a task list or a pause
// arriving. A pause is counted only where it has text to open onto, because a pause with none has
// no disclosure to identify — which is exactly the shape `withPauseCount` prepends.
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
}

const Ctx = createContext<ThreadDisclosures | null>(null);

/** The turn id a disclosure key belongs to. */
const turnOf = (key: string) => key.slice(0, key.indexOf(":"));

/**
 * One thread's disclosure state, mounted above its turns.
 */
export function DisclosureScope({ children }: { children: ReactNode }) {
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
    }),
    [open, touched, toggle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The thread's disclosure state where there is a scope, and nothing where there is not. */
export function useThreadDisclosures(): ThreadDisclosures | null {
  return useContext(Ctx);
}

/**
 * One disclosure's open state — the thread's where there is a scope, its own where there is not.
 */
// cm:guard the local fallback is deliberate and is not a second live path: it is what a leaf does
// when it is drawn OUTSIDE a thread, which is every test that mounts one card on its own and the
// kit gallery. Refusing to render without a scope would make the component unmountable in exactly
// the places it is easiest to read, and the fallback cannot disagree with the scope because a leaf
// only ever has one of the two.
export function useDisclosure(key?: string): readonly [boolean, () => void] {
  const thread = useThreadDisclosures();
  const [local, setLocal] = useState(false);
  const toggleLocal = useCallback(() => setLocal((v) => !v), []);
  const toggleShared = useCallback(() => {
    if (thread && key) thread.toggle(key);
  }, [thread, key]);
  return thread && key ? [thread.isOpen(key), toggleShared] : [local, toggleLocal];
}
