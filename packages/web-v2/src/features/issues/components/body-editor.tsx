"use client";

// The box a comment or a description is written in: CodeMirror with markdown
// highlighting, a formatting toolbar, and a pane showing what the kernel would
// store. Used by the description editor, the comment composer and the new-issue
// dialog.
//
// CodeMirror rather than a hand-rolled textarea because selection, undo and
// caret work is exactly the thing not worth owning — it is already the repo's
// editor engine (`features/skills/components/code-editor.tsx`), so this adds an
// import and no dependency, and the chrome stays ours and on tokens.
//
// ISS-967 also gave this toolbar a menu that inserted a `forge-*` component
// skeleton; the owner cut it on 2026-09-14 as the wrong direction — that format
// is for what an AGENT writes, not for a person filling markup in by hand.

import { markdown } from "@codemirror/lang-markdown";
import { useQuery } from "@tanstack/react-query";
import CodeMirror, { type EditorView } from "@uiw/react-codemirror";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { BodyView, IconButton, PreviewPane, Spinner, useDebounced } from "@/design";
import type { IconName } from "@/design/icons/icon";
import { formatApiError } from "@/lib/api/error";
import { bodyApi } from "../body-api";
import {
  cycleHeading,
  type Edit,
  makeFence,
  makeLink,
  toggleOrderedList,
  togglePrefix,
  toggleWrap,
} from "../markdown-actions";

const PREVIEW_DEBOUNCE_MS = 300;

interface Tool {
  icon: IconName;
  label: string;
  /** Shown in the tooltip/aria label when the action has a shortcut. */
  keys?: string;
  run: (span: { doc: string; from: number; to: number }) => Edit;
}

// cm:guard every entry is a pure function from `markdown-actions`, and a new one belongs there rather than inline: a CodeMirror view in jsdom has no layout, so an action written here is an action no test can assert the output of.
const TOOLS: Tool[] = [
  { icon: "bold", label: "Bold", keys: "Ctrl+B", run: (s) => toggleWrap(s, "**") },
  { icon: "italic", label: "Italic", keys: "Ctrl+I", run: (s) => toggleWrap(s, "_") },
  { icon: "code", label: "Inline code", run: (s) => toggleWrap(s, "`") },
  { icon: "link", label: "Link", keys: "Ctrl+K", run: makeLink },
  { icon: "heading", label: "Heading", run: cycleHeading },
  { icon: "quote", label: "Quote", run: (s) => togglePrefix(s, "> ") },
  { icon: "list", label: "Bulleted list", run: (s) => togglePrefix(s, "- ") },
  { icon: "list-ordered", label: "Numbered list", run: toggleOrderedList },
  { icon: "code-block", label: "Code block", run: (s) => makeFence(s, "") },
  { icon: "pipeline", label: "Mermaid diagram", run: (s) => makeFence(s, "mermaid") },
];

const SHORTCUTS: Record<string, number> = { b: 0, i: 1, k: 3 };

// cm:guard the shortcut is a plain listener on the EDITOR's own element, not a CodeMirror extension and not a `keydown` on the wrapping div. Not an extension because web-v2 resolves two physically distinct copies of `@codemirror/state` — its own and the hoisted root one — so an extension built against either fails the other's `instanceof` with "Unrecognized extension value in extension set" (2026-09-14). Not the div because a static element carrying a key handler is the a11y rule's case, and correctly: it fires for anything inside it rather than for the editor. The listener dies with `v.dom` when CodeMirror destroys it.
function shortcut(e: KeyboardEvent, v: EditorView): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const at = SHORTCUTS[e.key.toLowerCase()];
  if (at === undefined) return;
  const tool = TOOLS[at];
  if (!tool) return;
  e.preventDefault();
  applyTool(tool, v);
}

// cm:guard the change and the selection travel in ONE transaction, and the edit is never written back through `onChange` instead: a value swap re-renders with a selection computed against the old document, which drops the caret at the end on every button. (It is not an undo claim — CodeMirror's history groups transactions dispatched in the same tick, so splitting them still costs one undo.)
function applyTool(tool: Tool, v: EditorView): void {
  const { from, to } = v.state.selection.main;
  const edit = tool.run({ doc: v.state.doc.toString(), from, to });
  v.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.selectFrom, head: edit.selectTo },
  });
  v.focus();
}

export interface BodyEditorProps {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  label: string;
  /** Drawn on the toolbar row beside Preview — the caller's Save/Cancel. */
  actions?: ReactNode;
}

export function BodyEditor({
  value,
  onChange,
  rows = 10,
  placeholder,
  disabled,
  label,
  actions,
}: BodyEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const view = useRef<EditorView | null>(null);
  const debounced = useDebounced(value, PREVIEW_DEBOUNCE_MS);

  // cm:guard built ONCE and never from a value that changes per render: `extensions` is reconciled by identity, so an array rebuilt each render reconfigures the editor on every keystroke and drops the selection mid-word. `run` is a `useCallback` over no deps for the same reason.
  const extensions = useMemo(() => [markdown()], []);

  const preview = useQuery({
    queryKey: ["body", "preview", debounced],
    queryFn: () => bodyApi.preview(debounced),
    enabled: showPreview && debounced.trim().length > 0,
    retry: false,
  });

  const run = useCallback((tool: Tool) => {
    if (view.current) applyTool(tool, view.current);
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-line bg-sunken px-1 py-1">
        {TOOLS.map((tool) => (
          <IconButton
            key={tool.label}
            icon={tool.icon}
            size="sm"
            disabled={disabled}
            aria-label={tool.keys ? `${tool.label} (${tool.keys})` : tool.label}
            title={tool.keys ? `${tool.label} · ${tool.keys}` : tool.label}
            // cm:guard `onMouseDown` + preventDefault, not `onClick`: a click steals focus from the editor first, so by the time the handler runs the selection it is about to format has been collapsed.
            onMouseDown={(e) => {
              e.preventDefault();
              run(tool);
            }}
          />
        ))}
      </div>

      <div className="overflow-hidden rounded-md border border-line-strong bg-surface focus-within:border-[color:var(--link)] focus-within:shadow-[var(--shadow-focus)]">
        <CodeMirror
          value={value}
          onChange={onChange}
          onCreateEditor={(v) => {
            view.current = v;
            v.dom.addEventListener("keydown", (e) => shortcut(e, v));
          }}
          extensions={extensions}
          editable={!disabled}
          placeholder={placeholder}
          minHeight={`${rows * 1.5}rem`}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
          }}
          aria-label={label}
          className="fg-body-sm"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <PreviewPane
          open={showPreview}
          onToggle={() => setShowPreview((p) => !p)}
          status={
            preview.isFetching ? (
              <p className="fg-caption flex items-center gap-2 text-muted">
                <Spinner size={12} /> Checking…
              </p>
            ) : preview.isError ? (
              // cm:guard the refusal is the kernel's own message, which names the element, the attribute and its legal set — replacing it with a generic line removes the only thing that tells an author what to change (ISS-898's whole compliance result).
              <p className="fg-body-sm text-[color:var(--red-600)]">
                {formatApiError(preview.error)}
              </p>
            ) : null
          }
        >
          {preview.data ? (
            <BodyView
              body={preview.data.body}
              format={preview.data.format}
              nodes={preview.data.nodes}
            />
          ) : preview.isError ? null : (
            <p className="fg-body-sm text-muted">Nothing to preview yet.</p>
          )}
        </PreviewPane>
        {actions}
      </div>
    </div>
  );
}
