'use client';

import { EmptyState } from './EmptyState';

interface McpTabProps {
  mcpConfig: unknown;
}

export function McpTab({ mcpConfig }: McpTabProps) {
  if (mcpConfig == null) {
    return (
      <EmptyState
        title="No MCP servers configured"
        body="Job did not include mcpServers in its payload."
      />
    );
  }

  return (
    <div className="px-4 py-3">
      <p className="mb-2 text-[10px] uppercase tracking-widest text-outline">
        Secrets are redacted server-side as `[REDACTED N chars]`.
      </p>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface-container-low p-3 font-mono text-[11px] text-on-surface">
        {JSON.stringify(mcpConfig, null, 2)}
      </pre>
    </div>
  );
}
