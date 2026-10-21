"use client";

// While a room's message box has focus on a phone, the thread gets the room (ISS-1229 r32, judge-90):
// the bars around it left about 50 px of conversation with the keyboard up. `globals.css` hides what
// carries `STEPS_ASIDE` under the document's mark, below md.

import { useEffect, useState } from "react";

/** Spread on an element that steps aside under the mark. */
export const STEPS_ASIDE = { "data-steps-aside": "composing" } as const;

const PRESS_LANDS_MS = 800;

/** Marks the document while `active`; the mark goes with the room holding it. */
export function useComposingMark(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.composing = "";
    return () => {
      delete root.dataset.composing;
    };
  }, [active]);
}

/**
 * Whether the message box inside the element `ref` is given has focus. Focus moving to Send or another
 * control of the box is let go once that press lands as a click (or after `PRESS_LANDS_MS`): bars coming
 * back on the press would move the control from under the finger.
 */
export function useMessageBoxFocus<T extends HTMLElement>() {
  const [host, ref] = useState<T | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!host) {
      setFocused(false);
      return;
    }
    let pending: (() => void) | null = null;
    const cancel = () => {
      pending?.();
      pending = null;
    };
    const onIn = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLTextAreaElement)) return;
      cancel();
      setFocused(true);
    };
    const onOut = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLTextAreaElement)) return;
      cancel();
      const next = e.relatedTarget;
      if (!(next instanceof Node && host.contains(next))) {
        setFocused(false);
        return;
      }
      const letGo = () => {
        cancel();
        setFocused(false);
      };
      const timer = window.setTimeout(letGo, PRESS_LANDS_MS);
      window.addEventListener("click", letGo);
      pending = () => {
        window.clearTimeout(timer);
        window.removeEventListener("click", letGo);
      };
    };
    host.addEventListener("focusin", onIn);
    host.addEventListener("focusout", onOut);
    return () => {
      cancel();
      host.removeEventListener("focusin", onIn);
      host.removeEventListener("focusout", onOut);
    };
  }, [host]);

  return { focused, ref };
}
