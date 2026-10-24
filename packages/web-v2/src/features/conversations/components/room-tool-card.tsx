"use client";

// A tool call in a room, said as what the assistant did (ISS-1229 r34, judge-93). The tool's stored
// name, its arguments and its raw result are the technical view, folded until the reader opens it.

import { Icon } from "@/design";
import { useDisclosure } from "@/features/session/disclosure";
import { formatResultBody } from "@/features/session/result-summary";
import type { ToolCallData } from "@/features/session/types";
import { toolWords } from "../tool-words";

export function RoomToolCard({
  tool,
  live,
  blockKey,
  later,
}: {
  tool: ToolCallData;
  live?: boolean;
  blockKey?: string;
  /** The calls after this one in the same reply, which say whether the assistant took another way (r38). */
  later?: readonly ToolCallData[];
}) {
  const [open, toggle] = useDisclosure(blockKey);
  const words = toolWords(tool, live === true, later);
  const refused = tool.isError === true;
  const running = !refused && tool.result === undefined && live === true;
  return (
    <div className="border-l border-line py-1 pl-3" data-testid="room-tool-card">
      <p className="fg-body-sm flex items-start gap-2">
        <Icon
          name={refused ? "alert" : running ? "dot" : "check"}
          size={14}
          className="mt-0.5 flex-none"
          style={{ color: refused ? "var(--red-600)" : "var(--fg-subtle)" }}
        />
        <span data-testid="room-tool-said" className="min-w-0 break-words text-default">
          {words.said}
        </span>
      </p>
      {words.refusal && (
        <p data-testid="room-tool-refusal" className="fg-caption mt-0.5 break-words pl-[22px] text-muted">
          {words.refusal}
        </p>
      )}
      <button
        type="button"
        data-testid="tool-result-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="fg-caption mt-1 flex w-fit items-center gap-1 rounded pl-[22px] text-subtle hover:text-default"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} className="flex-none" />
        Technical details
      </button>
      {open && (
        <dl
          data-testid="room-tool-technical"
          className="mt-1 ml-[22px] max-h-64 overflow-auto border-l border-line-subtle pl-2 font-mono text-subtle"
          style={{ fontSize: "var(--text-11)" }}
        >
          <dt className="text-muted">tool</dt>
          <dd>{tool.name}</dd>
          <dt className="mt-1 text-muted">arguments</dt>
          <dd className="whitespace-pre-wrap break-all">{formatResultBody(tool.input ?? {})}</dd>
          <dt className="mt-1 text-muted">result</dt>
          <dd className="whitespace-pre-wrap break-all">
            {tool.result === undefined ? "none yet" : formatResultBody(tool.result)}
          </dd>
        </dl>
      )}
    </div>
  );
}
