'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import type { AgentRunLog } from '../../hooks/use-agent-run-log';

interface AgentRunLogProps {
  runLog: AgentRunLog;
}

export function AgentRunLog({ runLog }: AgentRunLogProps) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [runLog.log.length]);

  if (!runLog.status && runLog.log.length === 0) return null;

  return (
    <div className="border-t border-outline-variant/20 px-5 py-3">
      {runLog.status && (
        <p
          className={cn(
            'text-sm font-medium',
            runLog.isRunning
              ? 'text-info'
              : runLog.status.toLowerCase().includes('fail')
                ? 'text-danger'
                : 'text-success',
          )}
        >
          {runLog.isRunning && (
            <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-info" />
          )}
          {runLog.status}
        </p>
      )}
      {runLog.log.length > 0 && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded border border-outline-variant/20 bg-surface-container-low p-2 font-mono text-xs text-on-surface-variant">
          {runLog.log.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}
