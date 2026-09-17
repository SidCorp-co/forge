"use client";

// Tool-call card — one per `tool_use` block. Edit/Write/MultiEdit render an
// inline unified diff (collapsible); reads/searches/runs render a compact
// labeled row. Kit-only: imports from @/design, semantic tokens, no hex.
import { Icon, type IconName } from "@/design";
import { useDisclosure } from "../disclosure";
import { formatResultBody, summarizeResult } from "../result-summary";
import { buildFileDiff, getToolLabel, splitHunk, toolKind, type FileDiff, type ToolCallData } from "../types";

const KIND_ICON: Record<ReturnType<typeof toolKind>, IconName> = {
  edit: "branch",
  read: "folder",
  search: "search",
  run: "play",
  task: "agent",
  generic: "dot",
};

/** Inline unified diff for one file's collected hunks. */
export function InlineDiff({ diff }: { diff: FileDiff }) {
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

function EditCard({ tool, diff, blockKey }: { tool: ToolCallData; diff: FileDiff; blockKey?: string }) {
  const [open, toggle] = useDisclosure(blockKey);
  return (
    <div className="rounded-md border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
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
      {open && <InlineDiff diff={diff} />}
    </div>
  );
}

function SimpleCard({ tool, live, blockKey }: { tool: ToolCallData; live?: boolean; blockKey?: string }) {
  const [open, toggle] = useDisclosure(blockKey);
  const kind = toolKind(tool.name);
  const summary = summarizeResult(tool.result, tool.isError, live);
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
      {/* cm:guard the summary is a LINE and not a control unless there is a value behind it. A
          disclosure that opens onto nothing is the same affordance defect `thinking-line.tsx`
          refuses one component along, and a running call has nothing behind it yet. */}
      {summary.hasBody ? (
        <button
          type="button"
          data-testid="tool-result-toggle"
          aria-expanded={open}
          onClick={toggle}
          className="mt-1 flex w-fit items-center gap-1.5 rounded text-subtle hover:text-default"
          style={{ fontSize: 11 }}
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} className="flex-none" />
          <span data-testid="tool-result-summary" className="font-mono">{summary.label}</span>
        </button>
      ) : (
        <p
          data-testid="tool-result-summary"
          className="mt-1 font-mono text-subtle"
          style={{ fontSize: 11 }}
        >
          {summary.label}
        </p>
      )}
      {open && summary.hasBody && (
        // cm:guard the body wraps and scrolls INSIDE its own bounds. A tool result routinely carries
        // an id or a URL with no break in it, and the thread's width is the assistant column's to
        // decide — a card that widens the thread has taken that decision away from it.
        <pre
          data-testid="tool-result-body"
          className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all border-l border-line-subtle pl-2 font-mono text-subtle"
          style={{ fontSize: 11 }}
        >
          {formatResultBody(tool.result)}
        </pre>
      )}
    </div>
  );
}

/**
 * One tool call.
 */
// cm:why `live` is a prop rather than something the card works out: whether the turn is still
// arriving is the surface's fact, and `AgentTurn` already holds it as `streamingTail`. A card that
// guessed from its own emptiness would say "Running…" on every historical call that captured
// nothing (ISS-1083).
// cm:why `blockKey` is threaded down rather than built here: the key has to name the TURN this card
// belongs to, and a card knows only itself. `AgentTurn` builds it, which is also the only place that
// can guarantee the same key before and after the turn settles (`disclosure.tsx`).
export function ToolCard({ tool, live, blockKey }: { tool: ToolCallData; live?: boolean; blockKey?: string }) {
  const diff = buildFileDiff(tool);
  if (diff && diff.hunks.length > 0) return <EditCard tool={tool} diff={diff} blockKey={blockKey} />;
  return <SimpleCard tool={tool} live={live} blockKey={blockKey} />;
}
