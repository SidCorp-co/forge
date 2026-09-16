// A stand-in for `@uiw/react-codemirror`, for any jsdom test whose tree happens
// to contain a `BodyEditor`.
//
// It exists because a REAL CodeMirror cannot be mounted in this suite: it works
// standalone and dies in a shared worker with "Unrecognized extension value in
// extension set", because `@uiw/react-codemirror` (CJS) and
// `@codemirror/lang-markdown` (ESM) resolve two module instances of
// `@codemirror/state`, whose classes every extension is `instanceof`-checked
// against. A `pnpm.overrides` pin and `resolve.dedupe` were both tried and
// neither fixed it (2026-09-14). It passes alone and fails in a full run, which
// is the shape that reads as a flake.
//
// Use it from a test that merely RENDERS a tree containing the editor:
//
//   vi.mock("@uiw/react-codemirror", async () =>
//     (await import("@/test/codemirror-stub")).codeMirrorStub());

import { vi } from "vitest";

export interface Transaction {
  changes?: { from: number; to: number; insert: string };
  selection?: { anchor: number; head: number };
}

export class FakeView {
  doc: string;
  sel: { from: number; to: number };
  dom = document.createElement("div");
  focused = 0;
  onChange?: (v: string) => void;

  constructor(doc: string) {
    this.doc = doc;
    this.sel = { from: doc.length, to: doc.length };
  }

  get state() {
    return { doc: { toString: () => this.doc }, selection: { main: this.sel } };
  }

  dispatch(tr: Transaction) {
    if (tr.changes) {
      const c = tr.changes;
      this.doc = this.doc.slice(0, c.from) + c.insert + this.doc.slice(c.to);
      this.onChange?.(this.doc);
    }
    if (tr.selection) this.sel = { from: tr.selection.anchor, to: tr.selection.head };
  }

  focus() {
    this.focused += 1;
  }
}

/** The most recently mounted stand-in, for a test that drives the toolbar. */
export let lastView: FakeView | null = null;

export function codeMirrorStub() {
  return {
    default: ({
      value,
      onChange,
      onCreateEditor,
      "aria-label": label,
    }: {
      value: string;
      onChange: (v: string) => void;
      onCreateEditor: (v: unknown) => void;
      "aria-label": string;
    }) => {
      const view = new FakeView(value);
      view.onChange = onChange;
      lastView = view;
      onCreateEditor(view);
      return (
        <textarea aria-label={label} value={value} readOnly ref={(el) => el?.append(view.dom)} />
      );
    },
  };
}

/** Reset between cases so one test cannot read another's editor. */
export function resetCodeMirrorStub() {
  lastView = null;
  vi.clearAllMocks();
}
