'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ChevronLeft, KeyRound, Plus } from 'lucide-react';
import { Shell } from '@/components/layout/shell';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useProjects } from '@/features/project/hooks/use-projects';
import { CreateTokenModal } from '@/features/token/components/CreateTokenModal';
import { FreshAuthProvider } from '@/features/token/components/FreshAuthProvider';
import { PlaintextRevealModal } from '@/features/token/components/PlaintextRevealModal';
import { TokenAuditDrawer } from '@/features/token/components/TokenAuditDrawer';
import { TokenList } from '@/features/token/components/TokenList';
import { useRevokeToken, useTokens } from '@/features/token/hooks/use-tokens';
import type { Pat, PatWithPlaintext } from '@/features/token/types';

export default function TokensPage() {
  useSetPageTitle('Tokens');
  return (
    <FreshAuthProvider>
      <TokensPageInner />
    </FreshAuthProvider>
  );
}

function TokensPageInner() {
  const tokens = useTokens();
  const projects = useProjects();
  const revoke = useRevokeToken();

  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<PatWithPlaintext | null>(null);
  const [auditTokenId, setAuditTokenId] = useState<string | null>(null);

  const activeTokens = useMemo<Pat[]>(
    () => (tokens.data ?? []).filter((t) => t.revokedAt === null),
    [tokens.data],
  );

  const auditTokenName = useMemo(
    () => activeTokens.find((t) => t.id === auditTokenId)?.name ?? null,
    [activeTokens, auditTokenId],
  );

  async function handleRevoke(id: string) {
    await revoke.mutateAsync(id);
  }

  function handleCreated(token: PatWithPlaintext) {
    setCreateOpen(false);
    setRevealed(token);
  }

  return (
    <Shell>
      <div className="h-full overflow-y-auto bg-background">
        <div className="mx-auto max-w-5xl p-6 md:p-12">
          <Link
            href="/settings"
            className="mb-6 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-outline hover:text-on-surface"
          >
            <ChevronLeft className="h-3 w-3" />
            Back to settings
          </Link>

          <header className="mb-8">
            <div className="mb-2 flex items-baseline justify-between gap-4">
              <h1 className="text-4xl font-black tracking-tighter text-primary uppercase">
                Personal Access Tokens
              </h1>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90"
              >
                <Plus className="h-3.5 w-3.5" />
                New token
              </button>
            </div>
            <p className="max-w-2xl text-sm leading-relaxed text-on-surface-variant">
              Personal access tokens authenticate MCP clients and API calls
              outside of the browser session. Use a separate token per
              integration and revoke them as soon as they are no longer needed.
            </p>
          </header>

          {tokens.isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          {tokens.error && (
            <p className="text-sm text-error">{(tokens.error as Error).message}</p>
          )}
          {tokens.data && activeTokens.length === 0 && (
            <EmptyState onCreate={() => setCreateOpen(true)} />
          )}
          {activeTokens.length > 0 && (
            <TokenList
              tokens={activeTokens}
              projects={projects.data ?? []}
              onRevoke={handleRevoke}
              onOpenAudit={setAuditTokenId}
            />
          )}
        </div>
      </div>

      <CreateTokenModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      <PlaintextRevealModal
        open={revealed !== null}
        plaintext={revealed?.plaintext ?? null}
        onClose={() => setRevealed(null)}
      />
      <TokenAuditDrawer
        tokenId={auditTokenId}
        tokenName={auditTokenName}
        onClose={() => setAuditTokenId(null)}
      />
    </Shell>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface-dim p-8 text-center">
      <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-sm bg-surface-container-highest">
        <KeyRound className="h-5 w-5 text-primary" />
      </div>
      <h2 className="mb-2 text-lg font-bold tracking-tight text-on-surface">
        No tokens yet
      </h2>
      <p className="mx-auto mb-6 max-w-md text-sm text-on-surface-variant">
        Tokens let MCP clients and API integrations authenticate as you.
        They are shown only once at creation, scoped to selected projects,
        and can be revoked at any time.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90"
      >
        <Plus className="h-3.5 w-3.5" />
        Create your first token
      </button>
    </div>
  );
}
