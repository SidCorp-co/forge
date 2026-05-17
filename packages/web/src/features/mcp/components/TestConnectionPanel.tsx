'use client';

import { CheckCircle2, Loader2, PlugZap, XCircle } from 'lucide-react';
import { McpTestError } from '../api';
import { useTestConnection } from '../hooks/use-test-connection';

interface Props {
  mcpUrl: string;
  tokenPrefix: string | null;
  tokenPlaintext: string | null;
  projectSlug: string;
}

export function TestConnectionPanel({
  mcpUrl,
  tokenPrefix,
  tokenPlaintext,
  projectSlug,
}: Props) {
  const test = useTestConnection();
  const canTest = tokenPlaintext !== null && projectSlug.length > 0;

  function run() {
    if (!canTest) return;
    test.mutate({
      url: mcpUrl,
      token: tokenPlaintext as string,
      projectSlug,
    });
  }

  return (
    <section className="rounded-sm border border-outline-variant/40 bg-surface-container-lowest p-5">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-primary/10">
          <PlugZap className="h-3.5 w-3.5 text-primary" />
        </div>
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-primary">
          Test Connection
        </h2>
      </div>

      <dl className="mb-4 grid gap-2 text-[12px] sm:grid-cols-3">
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-widest text-outline">
            MCP URL
          </dt>
          <dd className="mt-1 break-all font-mono text-on-surface">{mcpUrl}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-widest text-outline">
            Token
          </dt>
          <dd className="mt-1 font-mono text-on-surface">
            {tokenPrefix ? `forge_pat_live_${tokenPrefix}…` : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-widest text-outline">
            Project slug
          </dt>
          <dd className="mt-1 font-mono text-on-surface">{projectSlug || '—'}</dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={run}
        disabled={!canTest || test.isPending}
        className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {test.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Test Connection
      </button>

      {!canTest && tokenPlaintext === null && tokenPrefix !== null && (
        <p className="mt-3 text-[12px] text-on-surface-variant">
          This token&apos;s plaintext is not in session memory — rotate or create a
          new token to enable Test Connection.
        </p>
      )}

      {test.isSuccess && (
        <div className="mt-4 flex items-start gap-2 rounded-sm border border-success/40 bg-success/5 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
          <div className="text-[12px] leading-relaxed text-on-surface">
            <p className="font-bold">
              {test.data.toolsCount} tools available
            </p>
            {test.data.sampleNames.length > 0 && (
              <p className="text-on-surface-variant">
                Sample: {test.data.sampleNames.join(', ')}
              </p>
            )}
          </div>
        </div>
      )}

      {test.isError && (
        <div className="mt-4 flex items-start gap-2 rounded-sm border border-error/40 bg-error/5 p-3">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-error" aria-hidden />
          <div className="text-[12px] leading-relaxed text-on-surface">
            {test.error instanceof McpTestError ? (
              <>
                <p className="font-bold">
                  HTTP {test.error.status}
                  {test.error.code ? ` · ${test.error.code}` : ''}
                </p>
                <p className="text-on-surface-variant">{test.error.message}</p>
              </>
            ) : (
              <p className="font-bold">{(test.error as Error).message}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
