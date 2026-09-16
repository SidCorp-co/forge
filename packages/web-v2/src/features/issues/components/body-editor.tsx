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

function shortcut(e: KeyboardEvent, v: EditorView): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const at = SHORTCUTS[e.key.toLowerCase()];
  if (at === undefined) return;
  const tool = TOOLS[at];
  if (!tool) return;
  e.preventDefault();
  applyTool(tool, v);
}

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
