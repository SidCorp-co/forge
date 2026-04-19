'use client';

import type { ToolCallData } from './chat-message-types';

const MAX_TOOL_OUTPUT = 2000;

export function DiffLine({ prefix, text, type }: { prefix: string; text: string; type: 'add' | 'remove' | 'context' }) {
  const styles: Record<string, { bg: string; color: string; prefixColor: string }> = {
    remove: { bg: '#c0392b', color: '#ffffff', prefixColor: '#ffffff' },
    add:    { bg: '#27ae60', color: '#000000', prefixColor: '#000000' },
    context:{ bg: 'transparent', color: '#666666', prefixColor: '#666666' },
  };
  const s = styles[type];
  return (
    <div style={{ backgroundColor: s.bg }}>
      <span className="inline-block w-6 select-none text-right pr-1" style={{ color: s.prefixColor }}>{prefix}</span>
      <span style={{ color: s.color }}>{text || ' '}</span>
    </div>
  );
}

export function EditToolBody({ tc }: { tc: ToolCallData }) {
  const input = tc.input ?? {};
  const oldStr = (input.old_string as string) ?? '';
  const newStr = (input.new_string as string) ?? '';
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  return (
    <pre className="mt-0.5 max-h-80 overflow-auto font-mono text-[11px] leading-[1.6]">
      {oldLines.map((line, i) => (
        <DiffLine key={`r${i}`} prefix="-" text={line} type="remove" />
      ))}
      {newLines.map((line, i) => (
        <DiffLine key={`a${i}`} prefix="+" text={line} type="add" />
      ))}
    </pre>
  );
}

export function WriteToolBody({ tc }: { tc: ToolCallData }) {
  const raw = tc.result ?? '';
  const result = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  const lines = result.split('\n');
  return (
    <pre className="mt-0.5 max-h-80 overflow-auto font-mono text-[11px] leading-[1.6]">
      {lines.map((line, i) => (
        <DiffLine key={i} prefix="+" text={line} type="add" />
      ))}
    </pre>
  );
}

export function DefaultToolBody({ tc }: { tc: ToolCallData }) {
  const raw = tc.result ?? '';
  const output = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  const truncated = output.length > MAX_TOOL_OUTPUT;
  return (
    <div className="ml-4 mt-0.5 mb-1 space-y-1">
      {tc.input && (
        <pre className="max-h-32 overflow-auto rounded bg-[#0a0a0a] px-2 py-1 font-mono text-[11px] text-[#888888] border border-[#222222]">
          {JSON.stringify(tc.input, null, 2)}
        </pre>
      )}
      {tc.result !== undefined && (
        <pre className="max-h-32 overflow-auto rounded bg-[#0a0a0a] px-2 py-1 font-mono text-[11px] text-[#888888] border border-[#222222]">
          {truncated ? output.slice(0, MAX_TOOL_OUTPUT) + '\n… (truncated)' : output}
        </pre>
      )}
    </div>
  );
}
