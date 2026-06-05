'use client';

import { useMemo, useState } from 'react';
import { Button, Input, Label } from '@/components/ui';
import { ApiError } from '@/lib/api/client';
import {
  useCreateIntegration,
  useDeleteIntegration,
  useIntegrations,
  useTestIntegration,
  useUpdateIntegration,
} from '@/features/integrations/hooks/use-integrations';
import type { IntegrationSummary } from '@/features/integrations/types';

interface EpodsystemSectionProps {
  projectId?: string;
  previewMode?: boolean;
}

/**
 * ISS-387 — Epodsystem storefront integration settings.
 *
 * One store per project (no staging/prod env toggle — staging ↔ theme draft,
 * prod ↔ theme main on the same store). Operator pastes the store endpoint +
 * `crmk_` API key, hits Test connection, and the healthcheck fills in the
 * store identity (name/slug/themes) surfaced in the Theme panel. Publish /
 * rollback run through the website pipeline (release stage), not from here.
 */
export function EpodsystemSection({ projectId, previewMode = false }: EpodsystemSectionProps) {
  if (previewMode || !projectId) {
    return (
      <section className="space-y-6">
        <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
            Epodsystem Storefront
          </h2>
          <span className="text-[9px] font-mono text-outline">INT_EPD</span>
        </div>
        <div className="rounded-sm border border-warning/30 bg-warning-dim/10 p-3 text-[10px] font-bold uppercase tracking-widest text-warning">
          Preview mode — pass projectId to enable
        </div>
      </section>
    );
  }

  const { data, isLoading, refetch } = useIntegrations(projectId);
  const existing = useMemo(
    () => (data?.items ?? []).find((i) => i.provider === 'epodsystem') ?? null,
    [data?.items],
  );

  return (
    <section className="space-y-6" data-testid="epodsystem-section">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          Epodsystem Storefront
        </h2>
        <span className="text-[9px] font-mono text-outline">INT_EPD</span>
      </div>

      {isLoading ? (
        <div className="text-sm text-outline">Loading…</div>
      ) : (
        <StorePanel projectId={projectId} existing={existing} onSaved={() => void refetch()} />
      )}
    </section>
  );
}

interface StorePanelProps {
  projectId: string;
  existing: IntegrationSummary | null;
  onSaved: () => void;
}

function StorePanel({ projectId, existing, onSaved }: StorePanelProps) {
  const create = useCreateIntegration(projectId);
  const update = useUpdateIntegration(projectId);
  const del = useDeleteIntegration(projectId);
  const test = useTestIntegration(projectId);

  const [endpoint, setEndpoint] = useState(existing?.config.endpoint ?? '');
  const [apiKey, setApiKey] = useState('');
  const [testResult, setTestResult] = useState<{ status: string; message?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const badge = badgeFor(existing);
  const cfg = existing?.config;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (existing) {
        const patch: Parameters<typeof update.mutateAsync>[0]['body'] = {
          config: { endpoint },
        };
        if (apiKey.trim().length > 0) {
          patch.secrets = { apiKey };
        }
        await update.mutateAsync({ id: existing.id, body: patch });
      } else {
        if (!apiKey.trim()) {
          setError('API key (crmk_…) is required for the first save');
          return;
        }
        await create.mutateAsync({
          provider: 'epodsystem',
          config: { endpoint },
          secrets: { apiKey },
        });
      }
      setApiKey('');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VAULT_NOT_CONFIGURED') {
        setError(
          'Server vault is not configured. Ask the operator to set INTEGRATION_MASTER_KEY on the core service and restart it, then try again.',
        );
        return;
      }
      setError(err instanceof Error ? err.message : 'save failed');
    }
  }

  async function handleTest() {
    if (!existing) {
      setTestResult({ status: 'error', message: 'save first' });
      return;
    }
    try {
      const res = await test.mutateAsync(existing.id);
      setTestResult({ status: res.status, message: res.message });
      // The healthcheck refreshes store identity diagnostics; refetch to show them.
      onSaved();
    } catch (err) {
      setTestResult({
        status: 'error',
        message: err instanceof Error ? err.message : 'test failed',
      });
    }
  }

  async function handleDelete() {
    if (!existing) return;
    if (!confirm('Delete the Epodsystem integration for this project?')) return;
    await del.mutateAsync(existing.id);
    onSaved();
  }

  return (
    <div
      className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-6"
      data-testid="epodsystem-panel"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs text-outline">
          One Epodsystem store per project. Builds run on the draft theme (staging); release
          promotes draft → main (production).
        </p>
        <span
          className={`text-[10px] uppercase tracking-wider font-mono px-2 py-1 rounded-sm ${badge.classes}`}
          data-testid="epodsystem-badge"
        >
          {badge.label}
        </span>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <Label>Store endpoint</Label>
          <Input
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://your-store.epodsystem.com"
            required
          />
        </div>
        <div>
          <Label>{existing ? 'API key (leave blank to keep existing)' : 'API key'}</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={existing ? '••••••••' : 'crmk_…'}
            autoComplete="new-password"
          />
        </div>

        {error && (
          <div className="rounded-sm border border-danger/30 bg-danger/10 p-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={create.isPending || update.isPending}>
            {existing ? 'Update' : 'Save'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleTest}
            disabled={!existing || test.isPending}
          >
            Test connection
          </Button>
          {existing && (
            <Button type="button" variant="secondary" onClick={handleDelete} className="text-danger">
              Delete
            </Button>
          )}
        </div>

        {testResult && (
          <div
            className={`rounded-sm border p-2 text-xs ${
              testResult.status === 'ok'
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-danger/30 bg-danger/10 text-danger'
            }`}
            data-testid="epodsystem-test-result"
          >
            {testResult.status}: {testResult.message ?? '(no message)'}
          </div>
        )}
      </form>

      {existing && <ThemePanel config={cfg} />}
    </div>
  );
}

/**
 * Read-only theme panel: shows the resolved store identity + draft/main theme
 * ids from the last healthcheck. Publish (draft → main) and rollback are
 * driven by the website pipeline's release stage (shop-publish skill), not a
 * direct button here in v1.
 */
function ThemePanel({ config }: { config: IntegrationSummary['config'] | undefined }) {
  if (!config) return null;
  const storefrontUrl = config.endpoint ?? null;
  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface-container/40 p-3 text-xs space-y-2 text-on-surface-variant">
      <div className="font-bold uppercase tracking-wider text-outline">Store &amp; themes</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
        <dt className="text-outline">Store</dt>
        <dd>{config.storeName ?? config.storeSlug ?? '— (run Test connection)'}</dd>
        <dt className="text-outline">Theme (main / prod)</dt>
        <dd>{config.themeId ?? '—'}</dd>
        <dt className="text-outline">Theme (draft / staging)</dt>
        <dd>{config.draftThemeId ?? '—'}</dd>
        <dt className="text-outline">Commerce</dt>
        <dd>{config.commerceEnabled == null ? '—' : config.commerceEnabled ? 'enabled' : 'disabled'}</dd>
      </dl>
      {storefrontUrl && (
        <a
          href={storefrontUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-primary underline"
        >
          Open storefront ↗
        </a>
      )}
      <div className="text-[10px] text-outline">
        Publish (draft → live) and rollback run through the website pipeline&apos;s release
        stage.
      </div>
    </div>
  );
}

function badgeFor(existing: IntegrationSummary | null): { label: string; classes: string } {
  if (!existing) {
    return {
      label: 'Not configured',
      classes: 'bg-warning/10 text-warning border border-warning/30',
    };
  }
  if (existing.lastHealthStatus === 'ok') {
    const name = existing.config.storeName;
    return {
      label: name ? `Connected to ${name}` : 'Connected',
      classes: 'bg-success/10 text-success border border-success/30',
    };
  }
  if (existing.lastHealthStatus === 'error') {
    return {
      label: 'Invalid key',
      classes: 'bg-danger/10 text-danger border border-danger/30',
    };
  }
  return {
    label: 'Untested',
    classes: 'bg-surface-container border border-outline-variant/30 text-outline',
  };
}
