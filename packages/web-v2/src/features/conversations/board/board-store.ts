// cm:why the board is one module-level store rather than component state: the assistant's actions (ISS-47's
// executor), the dock's width, the page snapshot and the canvas itself all read it, and they sit in
// different subtrees. The store holds the board as wireframe-v1 — the canvas is a view of it, and an
// edit the person makes that does not fit wireframe-v1 is held as the refusal that names it.

import type { WireframeDoc } from "@forge/contracts/wireframe";
import { useSyncExternalStore } from "react";

export interface BoardState {
  open: boolean;
  /** The board as the person last left it, when it reads as wireframe-v1. */
  doc: WireframeDoc | null;
  /** Why the canvas does not read as wireframe-v1 right now, by its WIREFRAME_* code. */
  refused: string | null;
  /** Bumped each time the doc is LOADED from outside the canvas, which the canvas redraws from. */
  loaded: number;
}

let state: BoardState = { open: false, doc: null, refused: null, loaded: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<BoardState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export const boardStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Show a document on the canvas, replacing what is there. */
  load(doc: WireframeDoc) {
    set({ open: true, doc, refused: null, loaded: state.loaded + 1 });
  },
  /** What the canvas reads as after the person edited it. */
  edited(reading: { doc: WireframeDoc } | { refused: string }) {
    if ("doc" in reading) set({ doc: reading.doc, refused: null });
    else set({ refused: reading.refused });
  },
  openBlank() {
    if (state.open) return;
    set({ open: true, doc: state.doc ?? { v: "wireframe-v1", shapes: [] }, loaded: state.loaded + 1 });
  },
  close() {
    set({ open: false });
  },
};

export function useBoard(): BoardState {
  return useSyncExternalStore(boardStore.subscribe, boardStore.get, boardStore.get);
}

let exporter: (() => Promise<string>) | null = null;
/** The open canvas's SVG export, registered by the canvas while it is mounted. */
export const boardExporter = {
  set(fn: (() => Promise<string>) | null) {
    exporter = fn;
  },
  svg: () => (exporter ? exporter() : Promise.resolve(null)),
};
