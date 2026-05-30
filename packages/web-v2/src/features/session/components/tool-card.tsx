"use client";

// Tool-call card — one per `tool_use` block. Edit/Write/MultiEdit render an
// inline unified diff (collapsible); reads/searches/runs render a compact
// labeled row. Kit-only: imports from @/design, semantic tokens, no hex.
import { useState } from "react";
import { Icon, type IconName } from "@/design";
import { buildFileDiff, getToolLabel, splitHunk, toolKind, type FileDiff, type ToolCallData } from "../types";

const KIND_ICON: Record<ReturnType<typeof toolKind>, IconName> = {
  edit: "branch",
  read: "folder",
  search: "search",
  run: "play",
  task: "agent",
  generic: "dot",
};

function resultPreview(result: unknown): string {
  if (result == null) return "";
  const s = typeof result === "string" ? result : JSON.stringify(result);
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

/** Inline unified diff for an edit-type tool. Collapsed by default. */
function DiffBody({ diff }: { diff: FileDiff }) {
  return (
    <div className="border-t border-line-subtle">
      {diff.hunks.map((hunk, i) => {
        const { prefix, removed, added, suffix } = splitHunk(hunk);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: hunks are positional + stable
          <div key={i} className="overflow-x-auto">
            {i > 0 && <div className="py-0.5 text-center text-subtle" style={{ fontSize: 10 }}>···</div>}
            <pre className="font-mono leading-[1.6]" style={{ fontSize: 11 }}>
              {prefix.map((l, j) => (
                <div key={`c0-${j}`} className="px-2 text-subtle">{`  ${l}`}</div>
              ))}
              {removed.map((l, j) => (
                <div key={`r-${j}`} className="px-2" style={{ color: "var(--red-600)", background: "var(--red-50)" }}>{`- ${l}`}</div>
              ))}
              {added.map((l, j) => (
                <div key={`a-${j}`} className="px-2" style={{ color: "var(--green-600)", background: "var(--green-50)" }}>{`+ ${l}`}</div>
              ))}
              {suffix.map((l, j) => (
                <div key={`c1-${j}`} className="px-2 text-subtle">{`  ${l}`}</div>
              ))}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function EditCard({ tool, diff }: { tool: ToolCallData; diff: FileDiff }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-h-11 items-center gap-2 px-3 py-2 text-left hover:bg-hover"
      >
        <Icon
          name="chevronRight"
          size={14}
          className="flex-none text-subtle transition-transform duration-[150ms]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        <Icon name={diff.isNew ? "plus" : "branch"} size={14} className="flex-none text-subtle" />
        <span className="flex-1 truncate font-mono" style={{ fontSize: 12 }}>{diff.path}</span>
        {diff.isNew && <span className="flex-none font-mono" style={{ fontSize: 10, color: "var(--green-600)" }}>NEW</span>}
        {diff.added > 0 && <span className="flex-none font-mono" style={{ fontSize: 11, color: "var(--green-600)" }}>+{diff.added}</span>}
        {diff.removed > 0 && <span className="flex-none font-mono" style={{ fontSize: 11, color: "var(--red-600)" }}>-{diff.removed}</span>}
      </button>
      {open && <DiffBody diff={diff} />}
    </div>
  );
}

function SimpleCard({ tool }: { tool: ToolCallData }) {
  const kind = toolKind(tool.name);
  const preview = resultPreview(tool.result);
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon
          name={tool.isError ? "alert" : KIND_ICON[kind]}
          size={14}
          className="flex-none"
          style={{ color: tool.isError ? "var(--red-600)" : "var(--fg-subtle)" }}
        />
        <span className="flex-1 truncate font-mono" style={{ fontSize: 12 }}>{getToolLabel(tool)}</span>
        {typeof tool.durationMs === "number" && (
          <span className="flex-none font-mono text-subtle" style={{ fontSize: 11 }}>
            {tool.durationMs >= 1000 ? `${(tool.durationMs / 1000).toFixed(1)}s` : `${tool.durationMs}ms`}
          </span>
        )}
      </div>
      {preview && (
        <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-subtle" style={{ fontSize: 11 }}>
          {preview}
        </pre>
      )}
    </div>
  );
}

export function ToolCard({ tool }: { tool: ToolCallData }) {
  const diff = buildFileDiff(tool);
  if (diff && diff.hunks.length > 0) return <EditCard tool={tool} diff={diff} />;
  return <SimpleCard tool={tool} />;
}
