"use client";

// One tool call per `tool_use` block, flat with a left rule. Edit/Write/MultiEdit render an
// inline unified diff (collapsible); reads/searches/runs render a compact
// labeled row. Kit-only: imports from @/design, semantic tokens, no hex.
import { Icon, type IconName } from "@/design";
import { cn } from "@/lib/utils/cn";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useDisclosure } from "../disclosure";
import { formatResultBody, summarizeResult } from "../result-summary";
import { buildFileDiff, splitHunk, type FileDiff } from "../derive";
import { getToolLabel, toolKind, type ToolCallData } from "../types";

const KIND_ICON: Record<ReturnType<typeof toolKind>, IconName> = {
  edit: "branch",
  read: "folder",
  search: "search",
  run: "play",
  task: "agent",
  generic: "dot",
};

/** One hunk as four blocks: the context before, the removed lines, the added lines, the context after. */
function Hunk({ hunk }: { hunk: FileDiff["hunks"][number] }) {
  const { prefix, removed, added, suffix } = splitHunk(hunk);
  const block = (lines: string[], mark: string) => lines.map((l) => `${mark} ${l}`).join("\n");
  return (
    <pre className="overflow-x-auto border-t border-dashed border-line-subtle font-mono leading-relaxed-1-6 text-12 first:border-t-0">
      {prefix.length > 0 && <div className="px-2 text-subtle">{block(prefix, " ")}</div>}
      {removed.length > 0 && <div className="bg-danger-3 px-2 text-danger-11">{block(removed, "-")}</div>}
      {added.length > 0 && <div className="bg-ok-3 px-2 text-ok-11">{block(added, "+")}</div>}
      {suffix.length > 0 && <div className="px-2 text-subtle">{block(suffix, " ")}</div>}
    </pre>
  );
}

/** Inline unified diff for one file's collected hunks. */
export function InlineDiff({ diff }: { diff: FileDiff }) {
  return (
    <div className="border-t border-line-subtle">
      {diff.hunks.map((hunk) => (
        // a hunk is what it replaces and with what: one edit never repeats another in a call
        <Hunk key={`${hunk.oldLines.join("\n")}\u0000${hunk.newLines.join("\n")}`} hunk={hunk} />
      ))}
    </div>
  );
}

function ToolEdit({ diff, blockKey }: { diff: FileDiff; blockKey?: string }) {
  const [open, toggle] = useDisclosure(blockKey);
  const t = useCopy();
  return (
    <div className="border-l-2 border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full min-h-11 items-center gap-2 px-3 py-2 text-left hover:bg-hover"
      >
        <Icon
          name="chevronRight"
          size={14}
          className={cn("flex-none text-subtle transition-transform duration-150", open && "rotate-90")}
        />
        <Icon name={diff.isNew ? "plus" : "branch"} size={14} className="flex-none text-subtle" />
        <span className="flex-1 truncate font-mono text-12">{diff.path}</span>
        {diff.isNew && <span className="flex-none font-mono text-12 text-ok-11">{t("sessions.tool.new")}</span>}
        {diff.added > 0 && <span className="flex-none font-mono text-12 text-ok-11">+{diff.added}</span>}
        {diff.removed > 0 && <span className="flex-none font-mono text-12 text-danger-11">-{diff.removed}</span>}
      </button>
      {open && <InlineDiff diff={diff} />}
    </div>
  );
}

function ToolRun({ tool, live, blockKey }: { tool: ToolCallData; live?: boolean; blockKey?: string }) {
  const [open, toggle] = useDisclosure(blockKey);
  const t = useCopy();
  const time = useTimeFormat();
  const kind = toolKind(tool.name);
  const summary = tool.withheld
    ? { label: t("sessions.result.withheld"), hasBody: false, pending: false }
    : summarizeResult(tool.result, tool.isError, live, t);
  return (
    <div className="border-l-2 border-line px-3 py-1.5">
      <div className="flex items-center gap-2">
        <Icon
          name={tool.isError ? "alert" : KIND_ICON[kind]}
          size={14}
          className={cn("flex-none", tool.isError ? "text-danger-11" : "text-subtle")}
        />
        <span className="flex-1 truncate font-mono text-12">{getToolLabel(tool, t)}</span>
        {typeof tool.durationMs === "number" && (
          <span className="flex-none font-mono text-subtle text-12">
            {tool.durationMs >= 1000 ? `${time.number(Number((tool.durationMs / 1000).toFixed(1)))}s` : `${tool.durationMs}ms`}
          </span>
        )}
      </div>
      {summary.hasBody ? (
        <button
          type="button"
          data-testid="tool-result-toggle"
          aria-expanded={open}
          onClick={toggle}
          className="mt-1 flex w-fit items-center gap-1.5 rounded-sm text-12 text-subtle hover:text-fg"
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} className="flex-none" />
          <span data-testid="tool-result-summary" className="font-mono">{summary.label}</span>
        </button>
      ) : (
        <p
          data-testid="tool-result-summary"
          className="mt-1 font-mono text-12 text-subtle"
        >
          {summary.label}
        </p>
      )}
      {open && summary.hasBody && (
        <pre
          data-testid="tool-result-body"
          className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all border-l border-line-subtle pl-2 font-mono text-12 text-subtle"
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
export function ToolCall({ tool, live, blockKey }: { tool: ToolCallData; live?: boolean; blockKey?: string }) {
  const diff = buildFileDiff(tool);
  if (diff && diff.hunks.length > 0) return <ToolEdit diff={diff} blockKey={blockKey} />;
  return <ToolRun tool={tool} live={live} blockKey={blockKey} />;
}
