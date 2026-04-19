'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, Loader2 } from 'lucide-react';

interface ChatToolCallProps {
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  isStreaming?: boolean;
  isError?: boolean;
}

export function ChatToolCall({ name, input, result, durationMs, isStreaming, isError }: ChatToolCallProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-2 rounded-lg border border-outline-variant/30 bg-surface-container-low text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-container-high transition-colors rounded-lg"
      >
        {isStreaming ? (
          <Loader2 className="h-3.5 w-3.5 text-info animate-spin shrink-0" />
        ) : (
          <Wrench className={`h-3.5 w-3.5 shrink-0 ${isError ? 'text-danger' : 'text-primary-fixed'}`} />
        )}
        <span className="font-medium text-on-surface-variant truncate">{name}</span>
        {durationMs != null && (
          <span className="text-outline ml-auto shrink-0">{(durationMs / 1000).toFixed(1)}s</span>
        )}
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-outline shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-outline shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-outline-variant/30 px-3 py-2 space-y-2">
          {input && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-outline mb-1">Input</p>
              <pre className="whitespace-pre-wrap break-all text-on-surface-variant bg-surface-container-low rounded p-2 max-h-40 overflow-auto">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-outline mb-1">Result</p>
              <pre className={`whitespace-pre-wrap break-all rounded p-2 max-h-40 overflow-auto ${isError ? 'text-danger bg-danger-surface' : 'text-on-surface-variant bg-surface-container-low'}`}>
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
