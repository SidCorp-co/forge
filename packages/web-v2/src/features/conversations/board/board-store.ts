// cm:why the board is one module-level store rather than component state: the assistant's actions (ISS-47's
// executor), the dock's width, the page snapshot and the canvas itself all read it, and they sit in
// different subtrees. The store holds the board as wireframe-v1 and the canvas is a read-only view of it:
// the board is the assistant's surface, and only ui.board.draw opens it.

import type { WireframeDoc } from "@forge/contracts/wireframe";
import { useSyncExternalStore } from "react";

export interface BoardState {
  open: boolean;
  /** The board as the assistant last drew it. */
  doc: WireframeDoc | null;
  /** Bumped each time the doc is loaded, which the canvas redraws from. */
  loaded: number;
}

let state: BoardState = { open: false, doc: null, loaded: 0 };
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
    set({ open: true, doc, loaded: state.loaded + 1 });
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
