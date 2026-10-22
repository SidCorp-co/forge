// The keys that decide the open row in the Approvals peek (REQ-48 r3 BC-14): a digit presses the answer
// the peek draws with it, asking for its words where the act takes them, and `x` selects the row. The
// peek shows each digit on its answer, so no key does what the panel does not say. Never while typing
// in a field, and never with a modifier, so the browser's own shortcuts and the peek's j/k/Enter/Esc
// keep theirs.

import { useEffect } from "react";

export interface DecisionKeys {
  /** Press the answer drawn `n`th, counted from 1. */
  answer: (n: number) => void;
  select: () => void;
}

const typing = (el: HTMLElement | null) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

export function useDecisionKeys(open: string | null, keys: DecisionKeys): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target as HTMLElement | null) || e.metaKey || e.ctrlKey || e.altKey) return;
      const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : null;
      if (digit === null && e.key !== "x") return;
      e.preventDefault();
      if (digit === null) keys.select();
      else keys.answer(digit);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, keys]);
}
