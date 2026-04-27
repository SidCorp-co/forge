'use client';

import { useState, useMemo } from 'react';
import { FileCode, ChevronDown, ChevronRight } from 'lucide-react';
import type { ChatMessageData, ToolCallData } from './chat-message-types';
import { DiffLine } from './tool-bodies';

interface FileDiff {
  filePath: string;
  hunks: { type: 'edit'; oldLines: string[]; newLines: string[] }[];
  isNew: boolean;
}

function extractFileDiffs(messages: ChatMessageData[]): FileDiff[] {
  const fileMap = new Map<string, FileDiff>();

  function processToolCall(tc: ToolCallData) {
    const input = tc.input ?? {};
    const filePath = (input.file_path as string) ?? '';
    if (!filePath) return;

    if (tc.name === 'Edit') {
      const oldStr = (input.old_string as string) ?? '';
      const newStr = (input.new_string as string) ?? '';
      if (!oldStr && !newStr) return;
      if (!fileMap.has(filePath)) fileMap.set(filePath, { filePath, hunks: [], isNew: false });
      fileMap.get(filePath)!.hunks.push({ type: 'edit', oldLines: oldStr.split('\n'), newLines: newStr.split('\n') });
    } else if (tc.name === 'Write') {
      const content = (input.content as string) ?? tc.result ?? '';
      if (!content) return;
      if (!fileMap.has(filePath)) fileMap.set(filePath, { filePath, hunks: [], isNew: true });
      const diff = fileMap.get(filePath)!;
      diff.isNew = true;
      // Replace any previous hunks for Write — the whole file is the content
      diff.hunks = [{ type: 'edit', oldLines: [], newLines: content.split('\n') }];
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    // From contentBlocks
    if (msg.contentBlocks) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use' && block.tool) processToolCall(block.tool);
      }
    }
    // From legacy toolCalls
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
    <div className="border border-outline-variant/30 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-container transition-colors"
      >
        {expanded ? <ChevronDown className="h-3 w-3 text-on-surface-variant shrink-0" /> : <ChevronRight className="h-3 w-3 text-on-surface-variant shrink-0" />}
        <FileCode className="h-3.5 w-3.5 text-on-surface-variant shrink-0" />
        <span className="font-mono text-xs text-on-surface truncate flex-1">{diff.filePath}</span>
        {diff.isNew && <span className="text-[10px] font-mono text-success shrink-0">NEW</span>}
        {addCount > 0 && <span className="text-[10px] font-mono text-success shrink-0">+{addCount}</span>}
        {removeCount > 0 && <span className="text-[10px] font-mono text-danger shrink-0">-{removeCount}</span>}
      </button>
      {expanded && (
        <div className="border-t border-outline-variant/30">
          {diff.hunks.map((hunk, i) => {
            // Unified diff: context prefix, then removed block, then added block, then context suffix
            const oldL = hunk.oldLines;
            const newL = hunk.newLines;

            let commonStart = 0;
            while (commonStart < oldL.length && commonStart < newL.length && oldL[commonStart] === newL[commonStart]) commonStart++;
            let commonEnd = 0;
            while (
              commonEnd < oldL.length - commonStart &&
              commonEnd < newL.length - commonStart &&
              oldL[oldL.length - 1 - commonEnd] === newL[newL.length - 1 - commonEnd]
            ) commonEnd++;

            const prefix = oldL.slice(0, commonStart);
            const removed = oldL.slice(commonStart, oldL.length - commonEnd);
            const added = newL.slice(commonStart, newL.length - commonEnd);
            const suffix = oldL.slice(oldL.length - commonEnd);

            return (
              <pre key={i} className="overflow-auto font-mono text-[11px] leading-[1.6]">
                {i > 0 && <div className="text-on-surface-variant text-center text-[10px] py-0.5">···</div>}
                {prefix.map((line, j) => (
                  <div key={`c0-${j}`} className="px-2 text-on-surface-variant">  {line}</div>
                ))}
                {removed.map((line, j) => (
                  <DiffLine key={`r-${j}`} prefix="-" text={line} type="remove" />
                ))}
                {added.map((line, j) => (
                  <DiffLine key={`a-${j}`} prefix="+" text={line} type="add" />
                ))}
                {suffix.map((line, j) => (
                  <div key={`c1-${j}`} className="px-2 text-on-surface-variant">  {line}</div>
                ))}
              </pre>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DiffSummary({ messages }: { messages: ChatMessageData[] }) {
  const diffs = useMemo(() => extractFileDiffs(messages), [messages]);
  const [expanded, setExpanded] = useState(false);

  if (diffs.length === 0) return null;

  const totalAdds = diffs.reduce((sum, d) => sum + d.hunks.reduce((s, h) => s + h.newLines.length, 0), 0);
  const totalRemoves = diffs.reduce((sum, d) => sum + d.hunks.reduce((s, h) => s + h.oldLines.length, 0), 0);

  return (
    <div className="border-t border-outline-variant/30 pt-3 mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 mb-2 hover:bg-surface-container rounded px-1 -mx-1 py-1 transition-colors"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-on-surface-variant" /> : <ChevronRight className="h-3.5 w-3.5 text-on-surface-variant" />}
        <span className="font-mono text-xs text-on-surface">
          {diffs.length} file{diffs.length !== 1 ? 's' : ''} changed
        </span>
        <span className="font-mono text-[10px] text-success">+{totalAdds}</span>
        <span className="font-mono text-[10px] text-danger">-{totalRemoves}</span>
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
