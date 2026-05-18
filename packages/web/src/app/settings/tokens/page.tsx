'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, KeyRound, LogIn, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useProjects } from '@/features/project/hooks/use-projects';
import { useRequireFreshAuth } from '@/features/auth/hooks/use-require-fresh-auth';
import { CreateTokenModal } from '@/features/token/components/CreateTokenModal';
import { PlaintextRevealModal } from '@/features/token/components/PlaintextRevealModal';
import { TokenAuditDrawer } from '@/features/token/components/TokenAuditDrawer';
import { TokenList } from '@/features/token/components/TokenList';
import { useRevokeToken, useTokens } from '@/features/token/hooks/use-tokens';
import { stashPlaintext } from '@/features/token/lib/plaintext-store';
import type { Pat, PatWithPlaintext } from '@/features/token/types';
import { ApiError } from '@/lib/api/client';

const REAUTH_ERROR_MESSAGES: Record<string, string> = {
  identity_mismatch:
    'That identity does not match this account. Sign in to the same provider you used originally.',
  oauth_not_linked: 'This account is not linked to that provider.',
};

type ReauthBanner = { kind: 'ok' } | { kind: 'error'; message: string } | null;

const REAUTH_INTENT_STORAGE_KEY = 'forge:reauth-intent';

function ReauthQueryReader({
  onChange,
  onResumeIntent,
}: {
  onChange: (next: ReauthBanner) => void;
  onResumeIntent: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const searchParams = useSearchParams();
  const reauthFlag = searchParams.get('reauth');
  const reauthErrorCode = searchParams.get('reauth_error');

  useEffect(() => {
    if (reauthFlag === 'ok') {
      onChange({ kind: 'ok' });
      // Refetch `me` so the freshly-stamped `lastFreshAuthAt` reaches the
      // client; otherwise `useRequireFreshAuth` would still see the stale
      // null and re-open the modal.
      qc.invalidateQueries({ queryKey: ['me', 'profile'] });
      const intent = (() => {
        try {
          return sessionStorage.getItem(REAUTH_INTENT_STORAGE_KEY);
        } catch {
          return null;
        }
      })();
      if (intent === '/settings/tokens') {
        try {
          sessionStorage.removeItem(REAUTH_INTENT_STORAGE_KEY);
        } catch {
          // ignore
        }
        onResumeIntent();
      }
      router.replace('/settings/tokens');
      const t = setTimeout(() => onChange(null), 6000);
      return () => clearTimeout(t);
    }
    if (reauthErrorCode) {
      onChange({
        kind: 'error',
        message:
          REAUTH_ERROR_MESSAGES[reauthErrorCode] ??
          'Re-authentication failed. Please try again.',
      });
      router.replace('/settings/tokens');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reauthFlag, reauthErrorCode]);

  return null;
}

export default function TokensPage() {
  useSetPageTitle('Tokens');
  const tokens = useTokens();
  const projects = useProjects();
  const revoke = useRevokeToken();
  const { require: requireFreshAuth, modal: reauthModal } = useRequireFreshAuth();

  const [reauthBanner, setReauthBanner] = useState<ReauthBanner>(null);

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
    stashPlaintext(token.id, token.plaintext);
    setCreateOpen(false);
    setRevealed(token);
  }

  return (
    <>
      <Suspense fallback={null}>
        <ReauthQueryReader
          onChange={setReauthBanner}
          onResumeIntent={() => setCreateOpen(true)}
        />
      </Suspense>
      <div className="h-full overflow-y-auto bg-background">
        <div className="mx-auto max-w-5xl p-6 md:p-12">
          <header className="mb-8">
            <div className="mb-2 flex items-baseline justify-between gap-4">
              <h1 className="text-4xl font-black tracking-tighter text-primary uppercase">
                Personal Access Tokens
              </h1>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                disabled={!!tokens.error}
                className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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

          {reauthBanner?.kind === 'ok' && (
            <div
              role="status"
              className="mb-6 flex items-start gap-2 border-l-2 border-l-success bg-success/10 px-4 py-3 text-[11px] uppercase tracking-[0.16em] text-on-surface"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
              <span>Re-authentication confirmed. Click New token to continue.</span>
            </div>
          )}
          {reauthBanner?.kind === 'error' && (
            <div
              role="alert"
              className="mb-6 flex items-start gap-2 border-l-2 border-l-error bg-error/10 px-4 py-3 text-[11px] uppercase tracking-[0.16em] text-on-surface"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 text-error" />
              <span>{reauthBanner.message}</span>
            </div>
          )}

          {tokens.isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          {tokens.error && (
            <TokensErrorState
              error={tokens.error}
              onRetry={() => tokens.refetch()}
              retrying={tokens.isFetching}
            />
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
        requireFreshAuth={requireFreshAuth}
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
      {reauthModal}
    </>
  );
}

function TokensErrorState({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const apiError = error instanceof ApiError ? error : null;
  const status = apiError?.status ?? 0;
  const code = apiError?.code;

  if (status === 401 || code === 'UNAUTHENTICATED' || code === 'INVALID_TOKEN') {
    return (
      <ErrorCard
        icon={<LogIn className="h-5 w-5 text-primary" />}
        title="Sign in to manage your tokens"
        body="Your session has expired. Sign in again to view and create personal access tokens."
        action={
          <Link
            href="/login?next=/settings/tokens"
            className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90"
          >
            <LogIn className="h-3.5 w-3.5" />
            Sign in
          </Link>
        }
      />
    );
  }

  if (code === 'EMAIL_NOT_VERIFIED') {
    return (
      <ErrorCard
        icon={<ShieldAlert className="h-5 w-5 text-warning" />}
        title="Verify your email to manage tokens"
        body="Personal access tokens are only available once your email is verified. Check your inbox or update your address in account settings."
        action={
          <Link
            href="/settings/account"
            className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90"
          >
            Go to account settings
          </Link>
        }
      />
    );
  }

  const isServerError = status >= 500 || (apiError && status === 0);
  const title = isServerError
    ? "We couldn't load your tokens"
    : 'Could not load tokens';
  const body = isServerError
    ? 'The token service is temporarily unavailable. Please try again in a moment.'
    : apiError?.message || (error instanceof Error ? error.message : 'Unknown error.');

  return (
    <ErrorCard
      icon={<AlertTriangle className="h-5 w-5 text-error" />}
      title={title}
      body={body}
      action={
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />
          {retrying ? 'Retrying…' : 'Try again'}
        </button>
      }
    />
  );
}

function ErrorCard({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface-dim p-8 text-center">
      <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-sm bg-surface-container-highest">
        {icon}
      </div>
      <h2 className="mb-2 text-lg font-bold tracking-tight text-on-surface">{title}</h2>
      <p className="mx-auto mb-6 max-w-md text-sm text-on-surface-variant">{body}</p>
      {action}
    </div>
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
