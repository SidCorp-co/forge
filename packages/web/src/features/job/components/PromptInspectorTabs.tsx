'use client';

import { X } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/client';
import { Skeleton } from '@/components/ui';
import type { JobDetailResponse } from '../api/job-api';
import type { PromptEnvelope } from '../types-prompt';
import { EmptyState } from './inspector-tabs/EmptyState';
import { PromptTab } from './inspector-tabs/PromptTab';
import { ResponseTab } from './inspector-tabs/ResponseTab';
import { UsageTab } from './inspector-tabs/UsageTab';
import { TimingTab } from './inspector-tabs/TimingTab';
import { McpTab } from './inspector-tabs/McpTab';
import { HistoryTab } from './inspector-tabs/HistoryTab';

export type InspectorTab = 'prompt' | 'response' | 'usage' | 'timing' | 'mcp' | 'history';

const TAB_ORDER: { id: InspectorTab; label: string }[] = [
  { id: 'prompt', label: 'Prompt' },
  { id: 'response', label: 'Response' },
  { id: 'usage', label: 'Usage' },
  { id: 'timing', label: 'Timing' },
  { id: 'mcp', label: 'MCP' },
  { id: 'history', label: 'History' },
];

interface Props {
  jobId: string;
  tab: InspectorTab;
  onTabChange: (t: InspectorTab) => void;
  promptQuery: UseQueryResult<PromptEnvelope, unknown>;
  jobQuery: UseQueryResult<JobDetailResponse, unknown>;
  onClose: () => void;
}

export function PromptInspectorTabs({
  jobId,
  tab,
  onTabChange,
  promptQuery,
  jobQuery,
  onClose,
}: Props) {
  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center justify-between border-b border-outline-variant/30 bg-surface-container-low px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            Prompt inspector
          </span>
          <code className="truncate font-mono text-xs text-on-surface">{jobId}</code>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="rounded p-1.5 text-on-surface-variant hover:text-on-surface"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <nav
        role="tablist"
        aria-label="Inspector tabs"
        className="flex shrink-0 gap-1 border-b border-outline-variant/30 bg-surface-container-low px-2"
      >
        {TAB_ORDER.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(t.id)}
              className={`relative px-3 py-2 text-[11px] font-medium uppercase tracking-widest transition-colors ${
                active
                  ? 'text-on-surface'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {t.label}
              {active && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 bg-primary" aria-hidden />
              )}
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Body tab={tab} promptQuery={promptQuery} jobQuery={jobQuery} />
      </div>
    </div>
  );
}

interface BodyProps {
  tab: InspectorTab;
  promptQuery: UseQueryResult<PromptEnvelope, unknown>;
  jobQuery: UseQueryResult<JobDetailResponse, unknown>;
}

function Body({ tab, promptQuery, jobQuery }: BodyProps) {
  if (promptQuery.isLoading) {
    return (
      <div className="space-y-2 px-4 py-3">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (promptQuery.error instanceof ApiError && promptQuery.error.status === 404) {
    return (
      <EmptyState
        title="No prompt snapshot stored"
        body="This job ran before v0.1.35 (W2.1.1 snapshot path). Re-run the pipeline step to capture a snapshot."
      />
    );
  }

  if (promptQuery.error instanceof ApiError && promptQuery.error.status === 410) {
    const archived = promptQuery.error.body as
      | { archived?: true; path?: string }
      | undefined;
    return (
      <EmptyState
        title="Snapshot archived"
        body="Older than the retention window — fetched from archive in W2.1.5."
        path={archived?.path}
      />
    );
  }

  if (promptQuery.error) {
    const msg =
      promptQuery.error instanceof Error ? promptQuery.error.message : String(promptQuery.error);
    return <EmptyState title="Failed to load prompt" body={msg} />;
  }

  const envelope = promptQuery.data;
  if (!envelope) {
    return <EmptyState title="No data" body="Prompt envelope was empty." />;
  }

  switch (tab) {
    case 'prompt':
      return <PromptTab envelope={envelope} />;
    case 'response':
      return <ResponseTab agentSessionId={jobQuery.data?.agentSessionId ?? null} />;
    case 'usage':
      return <UsageTab usage={envelope.actualUsage} />;
    case 'timing':
      return <TimingTab job={jobQuery.data} />;
    case 'mcp':
      return <McpTab mcpConfig={envelope.mcpConfig} />;
    case 'history': {
      const job = jobQuery.data;
      return (
        <HistoryTab
          jobId={envelope.jobId}
          issueId={job?.issueId ?? null}
          step={job?.type ?? null}
        />
      );
    }
  }
}
