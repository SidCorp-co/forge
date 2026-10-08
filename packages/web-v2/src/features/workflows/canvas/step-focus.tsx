"use client";

import { type ReactNode, useMemo, useState } from "react";
import { SearchBox, WalkBar } from "./controls";
import { type Canvas, pathOf, searchSteps, walkOrder } from "./model";
import { DetailPanel, type Selection } from "./panel";
import type { CanvasFocus, CanvasHealth } from "./workflow-canvas";

/** What both canvases share about attention: the selection and the path it lights, the search hits, and the walk through the design in reading order. */
export function useStepFocus(c: Canvas) {
  const [selection, setSelection] = useState<Selection>(null);
  const [walk, setWalk] = useState<number | null>(null);
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const order = useMemo(() => walkOrder(c), [c]);
  const hits = useMemo(() => new Set(searchSteps(c, query)), [c, query]);
  const step = selection && "step" in selection ? selection.step : null;
  const edge = selection && "edge" in selection ? selection.edge : null;
  const focus = useMemo(() => {
    if (step) return pathOf(c, step);
    const e = edge ? c.edges.find((x) => x.id === edge || `agg:${x.from}>${x.to}` === edge) : null;
    return e ? { nodes: new Set([e.from, e.to]), edges: new Set([e.id]) } : null;
  }, [c, step, edge]);

  /** Move the walk to stop `i`; returns the step to reveal there, or null past either end. */
  const advance = (i: number): string | null => {
    if (i < 0) return null;
    if (i >= order.length) {
      setWalk(order.length);
      setSelection(null);
      return null;
    }
    const id = order[i] as string;
    setWalk(i);
    setVisited((prev) => new Set([...prev, id]));
    return id;
  };
  const stopWalk = () => {
    setWalk(null);
    setVisited(new Set());
    setSelection(null);
  };

  return {
    selection,
    setSelection,
    step,
    edge,
    focus,
    query,
    setQuery,
    hits,
    order,
    walk,
    visited,
    /** A walk is under way and has a stop to show. */
    walking: walk !== null && walk < order.length,
    panelWalk: walk === null ? null : { order, at: walk },
    advance,
    /** Escape and the panel's close: end a walk, else clear the selection; false when there was neither. */
    dismiss: (): boolean => {
      if (walk !== null) stopWalk();
      else if (selection !== null) setSelection(null);
      else return false;
      return true;
    },
    stopWalk,
  };
}

export type StepFocus = ReturnType<typeof useStepFocus>;

/** The parts of a canvas's frame that answer to the focus: walking, search, the side panel and the keys; a compact canvas has none of the chrome. */
export function focusChrome(
  f: StepFocus,
  o: { c: Canvas; reveal: (id: string) => void; decision: ReactNode; compact?: boolean; health?: CanvasHealth | null; focus?: CanvasFocus | null },
) {
  const walkTo = (i: number) => {
    const id = f.advance(i);
    if (id) o.reveal(id);
  };
  const full = !o.compact;
  return {
    walkTo,
    dim: Boolean(f.focus),
    onPaneClick: () => f.setSelection(null),
    onEscape: f.dismiss,
    focus: full ? (o.focus ?? null) : null,
    onArrow: (dir: -1 | 1) => {
      if (f.walking && f.walk !== null) walkTo(f.walk + dir);
    },
    search: full ? <SearchBox c={o.c} hits={[...f.hits]} query={f.query} onQuery={f.setQuery} onPick={o.reveal} /> : null,
    walkBar: full && f.walking && f.walk !== null ? <WalkBar at={f.walk} total={f.order.length} onWalk={walkTo} onStop={f.stopWalk} /> : null,
    panel: full ? (
      <DetailPanel
        canvas={o.c}
        selection={f.selection}
        walk={f.panelWalk}
        decision={o.decision}
        onClose={f.dismiss}
        onWalk={walkTo}
        onStep={o.reveal}
        onEdge={(id) => f.setSelection({ edge: id })}
        health={o.health}
      />
    ) : null,
  };
}
