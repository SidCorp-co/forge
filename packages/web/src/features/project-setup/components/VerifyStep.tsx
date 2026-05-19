'use client';

import Link from 'next/link';
import { useState } from 'react';
import { agentApi, type AgentSession } from '@/features/agent/api';

interface Props {
  projectSlug: string;
  onSaved: () => void;
}

type PingStatus = 'idle' | 'running' | 'success' | 'failed';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30;

function lastAssistantText(session: AgentSession): string | null {
  const msgs = session.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: string; content?: unknown; text?: unknown };
    if (m?.role !== 'assistant') continue;
    if (typeof m.text === 'string' && m.text.length > 0) return m.text;
    if (typeof m.content === 'string' && m.content.length > 0) return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((c) =>
          typeof c === 'string'
            ? c
            : typeof (c as { text?: unknown })?.text === 'string'
              ? ((c as { text: string }).text)
              : '',
        )
        .join('');
      if (text.length > 0) return text;
    }
  }
  return null;
}

export function VerifyStep({ projectSlug, onSaved }: Props) {
  const [status, setStatus] = useState<PingStatus>('idle');
  const [evidence, setEvidence] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onRun = async () => {
    if (status === 'running') return;
    setStatus('running');
    setError(null);
    setEvidence(null);
    try {
      const start = await agentApi.start({ projectSlug, prompt: 'ping' });
      const sessionId = start.data.documentId;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const { data: session } = await agentApi.getSession(sessionId);
        if (session.status === 'completed') {
          setEvidence(lastAssistantText(session) ?? '(no assistant message)');
          setStatus('success');
          onSaved();
          return;
        }
        if (session.status === 'failed') {
          setError(
            typeof session.failureReason === 'string'
              ? session.failureReason
              : 'Agent session failed.',
          );
          setStatus('failed');
          return;
        }
      }
      setError('Timed out after 60s waiting for the agent to respond.');
      setStatus('failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start ping session.');
      setStatus('failed');
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-on-surface-variant">
        Send a quick &quot;ping&quot; to a runner to confirm the pipeline can reach a
        device. If your runner is online it should complete in under a minute.
      </p>

      <div className="flex gap-3 items-center">
        <button
          type="button"
          onClick={() => void onRun()}
          disabled={status === 'running'}
          className="bg-primary text-on-primary px-4 py-2 text-sm rounded-sm disabled:opacity-50"
        >
          {status === 'running' ? 'Pinging…' : 'Run ping test'}
        </button>
        {status === 'success' && <span className="text-xs text-success">Ping succeeded.</span>}
        {status === 'failed' && <span className="text-xs text-error">Ping failed.</span>}
      </div>

      {evidence && (
        <pre className="border border-outline-variant/20 bg-surface-container-low p-3 text-xs whitespace-pre-wrap text-on-surface">
          {evidence}
        </pre>
      )}

      {error && (
        <div className="space-y-2">
          <p className="text-xs text-error" role="alert">
            {error}
          </p>
          <Link
            href={`/projects/${projectSlug}/settings?section=devices`}
            className="text-xs underline text-primary"
          >
            Check device assignment
          </Link>
        </div>
      )}

      {status === 'success' && (
        <Link
          href={`/projects/${projectSlug}/issues/new`}
          className="inline-block border border-primary text-primary px-4 py-2 text-sm rounded-sm hover:bg-primary/10"
        >
          Create your first issue
        </Link>
      )}
    </div>
  );
}
