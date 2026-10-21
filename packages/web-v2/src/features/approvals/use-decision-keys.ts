// The keys that decide the open row in the Approvals peek (REQ-48 BC-11): `a` approves it, `d` asks
// for the decline's reason, `x` selects it. Never while typing in a field, and never with a modifier,
// so the browser's own shortcuts and the peek's j/k/Enter/Esc keep theirs.

import { useEffect } from "react";

export interface DecisionKeys {
  approve: () => void;
  decline: () => void;
  select: () => void;
}

const typing = (el: HTMLElement | null) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

export function useDecisionKeys(open: string | null, keys: DecisionKeys): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target as HTMLElement | null) || e.metaKey || e.ctrlKey || e.altKey) return;
      const act = e.key === "a" ? keys.approve : e.key === "d" ? keys.decline : e.key === "x" ? keys.select : null;
      if (!act) return;
      e.preventDefault();
      act();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, keys]);
}
