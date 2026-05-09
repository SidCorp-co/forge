import { useState, useMemo } from "react";
import type { AgentMessage, ToolCall } from "@/lib/types";
import { DiffLine } from "./chat-message-diff";

interface FileDiff {
  filePath: string;
  hunks: { oldLines: string[]; newLines: string[] }[];
  isNew: boolean;
}

function extractFileDiffs(messages: AgentMessage[]): FileDiff[] {
  const fileMap = new Map<string, FileDiff>();

  function processToolCall(tc: ToolCall) {
    const input = tc.input ?? {};
    const filePath = (input.file_path as string) ?? "";
    if (!filePath) return;

    if (tc.name === "Edit") {
      const oldStr = (input.old_string as string) ?? "";
      const newStr = (input.new_string as string) ?? "";
      if (!oldStr && !newStr) return;
      if (!fileMap.has(filePath)) fileMap.set(filePath, { filePath, hunks: [], isNew: false });
      fileMap.get(filePath)!.hunks.push({ oldLines: oldStr.split("\n"), newLines: newStr.split("\n") });
    } else if (tc.name === "Write") {
      const content = (input.content as string) ?? tc.output ?? "";
      if (!content) return;
      if (!fileMap.has(filePath)) fileMap.set(filePath, { filePath, hunks: [], isNew: true });
      const diff = fileMap.get(filePath)!;
      diff.isNew = true;
      diff.hunks = [{ oldLines: [], newLines: content.split("\n") }];
    }
  }

  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    if (msg.blocks) {
      for (const block of msg.blocks) {
        if (block.type === "tool" && block.toolCall) processToolCall(block.toolCall);
      }
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) processToolCall(tc);
    }
  }

  return Array.from(fileMap.values());
}

function FileDiffCard({ diff }: { diff: FileDiff }) {
  const [expanded, setExpanded] = useState(false);
  const addCount = diff.hunks.reduce((sum, h) => sum + h.newLines.length, 0);
  const removeCount = diff.hunks.reduce((sum, h) => sum + h.oldLines.length, 0);

  return (
    <div className="border border-[#333333] rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#1a1a1a] transition-colors"
      >
        <span className="text-[#666666] text-xs shrink-0">{expanded ? "▼" : "▶"}</span>
        <span className="font-mono text-xs text-[#cccccc] truncate flex-1">{diff.filePath}</span>
        {diff.isNew && <span className="text-[10px] font-mono text-[#27ae60] shrink-0">NEW</span>}
        {addCount > 0 && <span className="text-[10px] font-mono text-[#27ae60] shrink-0">+{addCount}</span>}
        {removeCount > 0 && <span className="text-[10px] font-mono text-[#c0392b] shrink-0">-{removeCount}</span>}
      </button>
      {expanded && (
        <div className="border-t border-[#333333]">
          {diff.hunks.map((hunk, i) => (
            <pre key={i} className="overflow-auto font-mono text-[11px] leading-[1.6]">
              {i > 0 && <div className="text-[#444444] text-center text-[10px] py-0.5">···</div>}
              {hunk.oldLines.map((line, j) => (
                <DiffLine key={`r${i}-${j}`} prefix="-" text={line} type="remove" />
              ))}
              {hunk.newLines.map((line, j) => (
                <DiffLine key={`a${i}-${j}`} prefix="+" text={line} type="add" />
              ))}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

export function DiffSummary({ messages }: { messages: AgentMessage[] }) {
  const diffs = useMemo(() => extractFileDiffs(messages), [messages]);
  const [expanded, setExpanded] = useState(true);

  if (diffs.length === 0) return null;

  const totalAdds = diffs.reduce((sum, d) => sum + d.hunks.reduce((s, h) => s + h.newLines.length, 0), 0);
  const totalRemoves = diffs.reduce((sum, d) => sum + d.hunks.reduce((s, h) => s + h.oldLines.length, 0), 0);

  return (
    <div className="border-t border-[#333333] pt-3 mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 mb-2 hover:bg-[#1a1a1a] rounded px-1 -mx-1 py-1 transition-colors"
      >
        <span className="text-[#666666] text-xs">{expanded ? "▼" : "▶"}</span>
        <span className="font-mono text-xs text-[#cccccc]">
          {diffs.length} file{diffs.length !== 1 ? "s" : ""} changed
        </span>
        <span className="font-mono text-[10px] text-[#27ae60]">+{totalAdds}</span>
        <span className="font-mono text-[10px] text-[#c0392b]">-{totalRemoves}</span>
      </button>
      {expanded && (
        <div className="space-y-1.5">
          {diffs.map((diff) => (
            <FileDiffCard key={diff.filePath} diff={diff} />
          ))}
        </div>
      )}
    </div>
  );
}
