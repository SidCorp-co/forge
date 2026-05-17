'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useProjects } from '@/features/project/hooks/use-projects';
import { useTokens } from '@/features/token/hooks/use-tokens';
import { getPlaintext } from '@/features/token/lib/plaintext-store';
import type { Pat } from '@/features/token/types';
import { ClientTabs } from '@/features/mcp/components/ClientTabs';
import { LibraryMcpsPlaceholder } from '@/features/mcp/components/LibraryMcpsPlaceholder';
import { QuickStartCard } from '@/features/mcp/components/QuickStartCard';
import { TestConnectionPanel } from '@/features/mcp/components/TestConnectionPanel';
import { getMcpUrl } from '@/features/mcp/lib/snippet-generators';

export default function McpSettingsPage() {
  useSetPageTitle('Settings · MCP');

  const tokens = useTokens();
  const projects = useProjects();
  const mcpUrl = useMemo(() => getMcpUrl(), []);

  const activeTokens = useMemo<Pat[]>(
    () => (tokens.data ?? []).filter((t) => t.revokedAt === null),
    [tokens.data],
  );

  const [tokenIdRaw, setTokenId] = useState<string | null>(null);
  const [projectIdRaw, setProjectId] = useState<string | null>(null);

  const tokenId = tokenIdRaw ?? activeTokens[0]?.id ?? null;
  const projectId = projectIdRaw ?? projects.data?.[0]?.id ?? null;

  const selectedToken = useMemo<Pat | null>(
    () => activeTokens.find((t) => t.id === tokenId) ?? null,
    [activeTokens, tokenId],
  );
  const selectedProject = useMemo(
    () => projects.data?.find((p) => p.id === projectId) ?? null,
    [projects.data, projectId],
  );

  const tokenPlaintext = selectedToken ? getPlaintext(selectedToken.id) : null;
  const projectSlug = selectedProject?.slug ?? '';

  const loading = tokens.isLoading || projects.isLoading;
  const hasNoTokens = !loading && activeTokens.length === 0;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-5xl space-y-6 p-6 md:p-12">
        <header>
          <h1 className="mb-2 text-4xl font-black uppercase tracking-tighter text-primary">
            MCP
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-on-surface-variant">
            Configure external MCP clients (Claude CLI, Cursor, Cline, Zed) to
            talk to Forge. Generate a per-client snippet, copy it into the
            client&apos;s config file, and verify the connection from your browser.
          </p>
        </header>

        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {!loading && hasNoTokens && <NoTokensEmptyState />}

        {!loading && !hasNoTokens && (
          <>
            <QuickStartCard />

            <section className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-outline">
                  Token
                </span>
                <select
                  value={tokenId ?? ''}
                  onChange={(e) => setTokenId(e.target.value || null)}
                  className="w-full rounded-sm border border-outline-variant/40 bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
                >
                  {activeTokens.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · forge_pat_live_{t.prefix}…
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-outline">
                  Project
                </span>
                <select
                  value={projectId ?? ''}
                  onChange={(e) => setProjectId(e.target.value || null)}
                  className="w-full rounded-sm border border-outline-variant/40 bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
                  disabled={!projects.data || projects.data.length === 0}
                >
                  {(projects.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.slug}
                    </option>
                  ))}
                </select>
              </label>
            </section>

            <ClientTabs
              input={{
                tokenPlaintext,
                projectSlug,
                mcpUrl,
              }}
            />

            <TestConnectionPanel
              mcpUrl={mcpUrl}
              tokenPrefix={selectedToken?.prefix ?? null}
              tokenPlaintext={tokenPlaintext}
              projectSlug={projectSlug}
            />

            <LibraryMcpsPlaceholder />
          </>
        )}
      </div>
    </div>
  );
}

function NoTokensEmptyState() {
  return (
    <div className="rounded-sm border border-outline-variant/40 bg-surface-container-lowest p-8 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-sm bg-surface-container-highest">
        <KeyRound className="h-5 w-5 text-primary" />
      </div>
      <h2 className="mb-1 text-lg font-bold tracking-tight text-primary">
        Create a token first
      </h2>
      <p className="mx-auto mb-5 max-w-md text-[13px] leading-relaxed text-on-surface-variant">
        MCP clients authenticate to Forge with a Personal Access Token. Create
        one on the Tokens tab, then come back to grab a per-client config
        snippet.
      </p>
      <Link
        href="/settings/tokens"
        className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90"
      >
        Create a token
      </Link>
    </div>
  );
}
