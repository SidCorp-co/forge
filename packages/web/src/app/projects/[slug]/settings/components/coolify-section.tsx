'use client';

import { useMemo, useState } from 'react';
import { Button, Input, Label } from '@/components/ui';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  useConfirmProdDeploy,
  useCreateIntegration,
  useDeleteIntegration,
  useIntegrations,
  useRollbackIntegration,
  useTestIntegration,
  useUpdateIntegration,
} from '@/features/integrations/hooks/use-integrations';
import type {
  IntegrationEnvironment,
  IntegrationSummary,
} from '@/features/integrations/types';

interface CoolifySectionProps {
  projectId?: string;
  previewMode?: boolean;
}

const ENV_OPTIONS: { value: IntegrationEnvironment; label: string }[] = [
  { value: 'staging', label: 'Staging' },
  { value: 'prod', label: 'Production' },
];

export function CoolifySection({ projectId, previewMode = false }: CoolifySectionProps) {
  const [activeEnv, setActiveEnv] = useState<IntegrationEnvironment>('staging');

  // Preview-mode placeholder kept for graceful fallback (tests, demo screens).
  if (previewMode || !projectId) {
    return (
      <section className="space-y-6">
        <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
            Coolify Deploy
          </h2>
          <span className="text-[9px] font-mono text-outline">INT_CLF</span>
        </div>
        <div className="rounded-sm border border-warning/30 bg-warning-dim/10 p-3 text-[10px] font-bold uppercase tracking-widest text-warning">
          Preview mode — pass projectId to enable
        </div>
      </section>
    );
  }

  const { data, isLoading, refetch } = useIntegrations(projectId);
  const integrations = useMemo(
    () => (data?.items ?? []).filter((i) => i.provider === 'coolify'),
    [data?.items],
  );
  const stagingRow = integrations.find((i) => i.environment === 'staging') ?? null;
  const prodRow = integrations.find((i) => i.environment === 'prod') ?? null;

  return (
    <section className="space-y-6" data-testid="coolify-section">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          Coolify Deploy
        </h2>
        <span className="text-[9px] font-mono text-outline">INT_CLF</span>
      </div>

      <SegmentedControl
        options={ENV_OPTIONS}
        value={activeEnv}
        onChange={setActiveEnv}
      />

      {isLoading ? (
        <div className="text-sm text-outline">Loading…</div>
      ) : (
        <EnvironmentPanel
          projectId={projectId}
          environment={activeEnv}
          existing={activeEnv === 'staging' ? stagingRow : prodRow}
          onSaved={() => void refetch()}
        />
      )}
    </section>
  );
}

interface EnvPanelProps {
  projectId: string;
  environment: IntegrationEnvironment;
  existing: IntegrationSummary | null;
  onSaved: () => void;
}

function EnvironmentPanel({ projectId, environment, existing, onSaved }: EnvPanelProps) {
  const create = useCreateIntegration(projectId);
  const update = useUpdateIntegration(projectId);
  const del = useDeleteIntegration(projectId);
  const test = useTestIntegration(projectId);
  const rollback = useRollbackIntegration(projectId);
  const confirmProd = useConfirmProdDeploy(projectId);

  const [baseUrl, setBaseUrl] = useState(existing?.config.baseUrl ?? '');
  const [resourceUuid, setResourceUuid] = useState(existing?.config.resourceUuid ?? '');
  const [branch, setBranch] = useState(existing?.config.branch ?? 'main');
  const [apiToken, setApiToken] = useState('');
  const [testResult, setTestResult] = useState<{ status: string; message?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isProd = environment === 'prod';
  const badge = badgeFor(existing);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (existing) {
        const patch: Parameters<typeof update.mutateAsync>[0]['body'] = {
          config: { baseUrl, resourceUuid, branch },
        };
        if (apiToken.trim().length > 0) {
          patch.secrets = { apiToken };
        }
        await update.mutateAsync({ id: existing.id, body: patch });
      } else {
        if (!apiToken.trim()) {
          setError('API token is required for the first save');
          return;
        }
        await create.mutateAsync({
          provider: 'coolify',
          environment,
          config: { baseUrl, resourceUuid, branch },
          secrets: { apiToken },
        });
      }
      setApiToken('');
      onSaved();
    } catch (err) {
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
    } catch (err) {
      setTestResult({ status: 'error', message: err instanceof Error ? err.message : 'test failed' });
    }
  }

  async function handleRollback() {
    if (!existing) return;
    if (!confirm(`Roll back last deploy for ${environment}? This is irreversible.`)) return;
    try {
      await rollback.mutateAsync(existing.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'rollback failed');
    }
  }

  async function handleDelete() {
    if (!existing) return;
    if (!confirm(`Delete ${environment} Coolify integration?`)) return;
    await del.mutateAsync(existing.id);
    onSaved();
  }

  async function handleConfirmProd() {
    if (!existing) return;
    await confirmProd.mutateAsync(existing.id);
    onSaved();
  }

  return (
    <div
      className={`bg-surface-container-low border p-8 space-y-6 ${
        isProd ? 'border-danger/40' : 'border-outline-variant/30'
      }`}
      data-testid={`coolify-panel-${environment}`}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs text-outline">
          {isProd
            ? '⚠ Production — manual confirmation gate before every deploy.'
            : 'Staging — auto-dispatch on release.'}
        </p>
        <span
          className={`text-[10px] uppercase tracking-wider font-mono px-2 py-1 rounded-sm ${badge.classes}`}
          data-testid={`coolify-badge-${environment}`}
        >
          {badge.label}
        </span>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <Label>Base URL</Label>
          <Input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://coolify.example.com"
            required
          />
        </div>
        <div>
          <Label>Resource UUID</Label>
          <Input
            type="text"
            value={resourceUuid}
            onChange={(e) => setResourceUuid(e.target.value)}
            placeholder="application uuid from Coolify"
            required
          />
        </div>
        <div>
          <Label>Branch</Label>
          <Input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            required
          />
        </div>
        <div>
          <Label>{existing ? 'API token (leave blank to keep existing)' : 'API token'}</Label>
          <Input
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder={existing ? '••••••••' : 'Coolify API token'}
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
          <Button
            type="button"
            variant="secondary"
            onClick={handleRollback}
            disabled={!existing || rollback.isPending}
          >
            Rollback last deploy
          </Button>
          {existing && (
            <Button
              type="button"
              variant="secondary"
              onClick={handleDelete}
              className="text-danger"
            >
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
            data-testid="coolify-test-result"
          >
            {testResult.status}: {testResult.message ?? '(no message)'}
          </div>
        )}

        {isProd && existing && (
          <ProdConfirmBanner integration={existing} onConfirm={handleConfirmProd} />
        )}
      </form>
    </div>
  );
}

interface BannerProps {
  integration: IntegrationSummary;
  onConfirm: () => Promise<void> | void;
}

function ProdConfirmBanner({ integration, onConfirm }: BannerProps) {
  // The pipeline_runs metadata gate carries `confirmedAt`. We don't read it
  // directly here — the server returns confirmed=false when no gate exists,
  // so the button simply calls confirm-prod-deploy and reports the outcome.
  return (
    <div className="rounded-sm border border-warning/40 bg-warning/10 p-3 text-xs space-y-2">
      <div className="font-bold uppercase tracking-wider text-warning">
        Production approval gate
      </div>
      <div className="text-on-surface-variant">
        Production deploys never auto-dispatch. Click confirm when ready to release the
        gate for an in-flight pipeline run.
      </div>
      <Button type="button" onClick={() => void onConfirm()} size="sm">
        Confirm production deploy
      </Button>
      <div className="font-mono text-[10px] text-outline">integration: {integration.id}</div>
    </div>
  );
}

function badgeFor(existing: IntegrationSummary | null): { label: string; classes: string } {
  if (!existing) {
    return { label: 'Not configured', classes: 'bg-warning/10 text-warning border border-warning/30' };
  }
  if (!existing.active) {
    return { label: 'Breaker open', classes: 'bg-danger/10 text-danger border border-danger/30' };
  }
  if (existing.lastHealthStatus === 'ok') {
    return { label: 'Connected', classes: 'bg-success/10 text-success border border-success/30' };
  }
  if (existing.lastHealthStatus === 'error') {
    return { label: 'Last deploy failed', classes: 'bg-danger/10 text-danger border border-danger/30' };
  }
  return { label: 'Untested', classes: 'bg-surface-container border border-outline-variant/30 text-outline' };
}
