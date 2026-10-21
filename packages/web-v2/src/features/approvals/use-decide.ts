// Deciding on the Approvals page with a five-second Undo (REQ-48 BC-11). A decision is held for
// five seconds before it is sent, so Undo takes back every act, including one with no inverse route
// (an accepted suggestion cannot be un-accepted): nothing has left the page while Undo is offered.
// A new decision sends the one held before it at once, leaving the page sends what it holds, and a
// post core refuses is put back in the list and named.

import type { DecisionAnswer } from "@forge/contracts/needs-you-decisions";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatApiError } from "@/lib/api/error";
import { NEEDS_YOU_ROOT, needsYouApi, pressBody } from "@/features/needs-you";

export const UNDO_MS = 5000;

/** One decision taken on the page: the row, the answer pressed and the words typed for it. */
export interface Decided {
  id: string;
  key: string;
  answer: DecisionAnswer;
  reason: string | null;
  how: "approved" | "declined";
}

/** What a sent decision changes besides the list itself, read again once it lands. */
const TOUCHES = [NEEDS_YOU_ROOT, ["suggestions"], ["mockups"], ["requirement"], ["requirements"], ["workflow"], ["workflows"], ["feedback"], ["issues"]] as const;

export interface DecideState {
  /** Ids held or being sent: out of the list while they are. */
  held: ReadonlySet<string>;
  /** The batch Undo takes back, while it may. */
  undoable: Decided[] | null;
  /** The decisions core refused, each with what it said. */
  failed: { key: string; error: string }[];
  decide: (batch: Decided[]) => void;
  undo: () => void;
  dismissFailed: () => void;
}

export function useDecide(): DecideState {
  const qc = useQueryClient();
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [undoable, setUndoable] = useState<Decided[] | null>(null);
  const [failed, setFailed] = useState<{ key: string; error: string }[]>([]);
  const waitingRef = useRef<{ batch: Decided[]; timer: ReturnType<typeof setTimeout> } | null>(null);

  const release = useCallback((ids: readonly string[]) => {
    setHeld((h) => {
      const next = new Set(h);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const send = useCallback(
    async (batch: Decided[]) => {
      const refused: { key: string; error: string }[] = [];
      for (const d of batch) {
        try {
          await needsYouApi.press(d.answer.path, pressBody(d.answer, d.reason));
        } catch (err) {
          refused.push({ key: d.key, error: formatApiError(err) });
        }
      }
      await Promise.all(TOUCHES.map((queryKey) => qc.invalidateQueries({ queryKey: [...queryKey] })));
      release(batch.map((d) => d.id));
      if (refused.length > 0) setFailed((f) => [...f, ...refused]);
    },
    [qc, release],
  );

  const flush = useCallback(() => {
    const w = waitingRef.current;
    if (!w) return;
    clearTimeout(w.timer);
    waitingRef.current = null;
    setUndoable(null);
    void send(w.batch);
  }, [send]);

  const decide = useCallback(
    (batch: Decided[]) => {
      if (batch.length === 0) return;
      flush();
      setHeld((h) => new Set([...h, ...batch.map((d) => d.id)]));
      setUndoable(batch);
      waitingRef.current = { batch, timer: setTimeout(flush, UNDO_MS) };
    },
    [flush],
  );

  const undo = useCallback(() => {
    const w = waitingRef.current;
    if (!w) return;
    clearTimeout(w.timer);
    waitingRef.current = null;
    setUndoable(null);
    release(w.batch.map((d) => d.id));
  }, [release]);

  // leaving the page sends what it holds: a decision taken is never dropped by navigating away
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  return { held, undoable, failed, decide, undo, dismissFailed: () => setFailed([]) };
}
