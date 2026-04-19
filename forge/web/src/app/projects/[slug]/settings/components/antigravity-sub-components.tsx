'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { projectApi } from '@/features/project/api/project-api';
import type { AntigravityRunner } from '@/features/project/types';
import { Loader2, CheckCircle, XCircle, Trash2, RefreshCw, Timer } from 'lucide-react';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export const STEP_LABELS: Record<string, string> = {
  create: 'Create project',
  clone: 'Clone repository',
  skills: 'Sync skills',
};

export function StepIndicator({ label, status }: { label: string; status: StepStatus }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-info" />}
      {status === 'done' && <CheckCircle className="h-3 w-3 text-success" />}
      {status === 'failed' && <XCircle className="h-3 w-3 text-danger" />}
      {status === 'skipped' && <span className="h-3 w-3 text-center text-outline">—</span>}
      {status === 'pending' && <span className="h-3 w-3 rounded-full border border-outline-variant" />}
      <span className={status === 'running' ? 'text-info font-medium' : status === 'failed' ? 'text-danger' : 'text-on-surface-variant'}>
        {label}
      </span>
    </div>
  );
}

/** Countdown timer that auto-updates every second. */
export function CountdownTimer({ target }: { target: string }) {
  const [remaining, setRemaining] = useState('');

  useEffect(() => {
    const update = () => {
      const diff = new Date(target).getTime() - Date.now();
      if (diff <= 0) { setRemaining('now'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setRemaining(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [target]);

  return <span className="font-mono">{remaining}</span>;
}

/** Per-runner card within the project's runner pool. */
export function ProjectRunnerCard({
  runner,
  projectMap,
  projectDocumentId,
  gitRepoUrl,
  onUpdate,
}: {
  runner: AntigravityRunner;
  projectMap: Record<string, string>;
  projectDocumentId?: string;
  gitRepoUrl?: string;
  onUpdate: () => void;
}) {
  const agProjectId = projectMap[runner.documentId] || '';
  const isInitialized = !!agProjectId;
  const [initializing, setInitializing] = useState(false);
  const [initSteps, setInitSteps] = useState<Record<string, StepStatus> | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; time: number } | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleInit = async () => {
    setInitializing(true);
    setError(null);
    setInitSteps({ create: 'running', clone: 'pending', skills: 'pending' });
    try {
      const res = await projectApi.antigravityInitProjectOnRunner(runner.documentId, gitRepoUrl, projectDocumentId);
      const newProjectId = res.data?.projectId;
      if (!newProjectId) { setError('No project ID returned'); setInitializing(false); return; }

      setInitSteps({ create: 'done', clone: gitRepoUrl ? 'running' : 'skipped', skills: 'pending' });

      // Save mapping immediately
      if (projectDocumentId) {
        const newMap = { ...projectMap, [runner.documentId]: newProjectId };
        await projectApi.update(projectDocumentId, { antigravityProjectMap: newMap } as any);
      }

      // Poll init progress
      pollRef.current = setInterval(async () => {
        try {
          const status = await projectApi.antigravityInitStatus(newProjectId);
          const steps = (status.data?.steps || {}) as Record<string, StepStatus>;
          setInitSteps(steps);
          if (status.data?.status === 'done') {
            stopPolling();
            setInitializing(false);
            onUpdate();
          }
        } catch { /* retry */ }
      }, 3000);
    } catch (err: any) {
      setError(err.message || 'Init failed');
      setInitializing(false);
      setInitSteps(null);
    }
  };

  const handleCheckStatus = async () => {
    if (!agProjectId) return;
    setChecking(true);
    setCheckResult(null);
    setError(null);
    try {
      const res = await projectApi.antigravityTestConnection(agProjectId);
      setCheckResult({ ok: res.data.ok, time: res.data.elapsedSeconds });
    } catch (err: any) {
      setCheckResult({ ok: false, time: 0 });
      setError(err.message);
    }
    setChecking(false);
  };

  const handleSyncSkills = async () => {
    if (!agProjectId) return;
    setSyncing(true);
    setError(null);
    try {
      await projectApi.antigravitySyncSkills(agProjectId, projectDocumentId);
    } catch (err: any) {
      setError(err.message);
    }
    setSyncing(false);
  };

  const handleDisconnect = async () => {
    if (!agProjectId) return;
    const confirmed = window.confirm(`Delete Antigravity project on ${runner.name} and disconnect?`);
    if (!confirmed) return;
    setDisconnecting(true);
    try {
      await projectApi.antigravityDeleteProject(agProjectId);
    } catch { /* still disconnect locally */ }
    if (projectDocumentId) {
      const newMap = { ...projectMap };
      delete newMap[runner.documentId];
      await projectApi.update(projectDocumentId, { antigravityProjectMap: newMap } as any);
    }
    setDisconnecting(false);
    onUpdate();
  };

  const statusColor = runner.status === 'online' ? 'bg-success' : runner.status === 'error' ? 'bg-warning' : 'bg-surface-variant';

  return (
    <div className={`border border-outline-variant/20 bg-surface-container-lowest p-4 space-y-2${runner.excluded ? ' opacity-60' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${statusColor}`} />
          <span className="text-sm font-medium text-on-surface">{runner.name}</span>
          {runner.excluded && (
            <span className="text-[9px] font-bold text-danger uppercase bg-danger-surface border border-danger/20 px-1.5 py-0.5 rounded-sm">EXCLUDED</span>
          )}
          <span className="text-[10px] font-mono text-outline truncate max-w-[200px]">{runner.agentId ? `Agent: ${runner.agentId.slice(0, 8)}…` : runner.endpoint || '—'}</span>
        </div>
      </div>

      {/* Depleted models countdown */}
      {runner.depletedModels && Object.keys(runner.depletedModels).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {Object.entries(runner.depletedModels).map(([model, resetAt]) => {
            const active = new Date(resetAt).getTime() > Date.now();
            return (
              <span key={model} className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] ${active ? 'border-warning/30 bg-warning-surface text-warning' : 'border-outline-variant/20 bg-surface text-outline line-through'}`}>
                <Timer className="h-3 w-3" />
                {model} {active ? <>— resets <CountdownTimer target={resetAt} /></> : '— expired'}
              </span>
            );
          })}
          <button
            onClick={async () => {
              await projectApi.clearRunnerDepletedModels(runner.documentId);
              onUpdate();
            }}
            className="inline-flex items-center gap-1 rounded border border-outline-variant/20 px-2 py-0.5 text-[10px] text-on-surface-variant hover:bg-surface-container-low"
          >
            <XCircle className="h-3 w-3" />
            Clear
          </button>
        </div>
      )}

      {!isInitialized ? (
        <div className="space-y-2">
          <button
            onClick={handleInit}
            disabled={initializing || runner.status !== 'online' || !!runner.excluded}
            className="flex items-center gap-2 rounded bg-surface px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-container disabled:opacity-50"
          >
            {initializing && <Loader2 className="h-3 w-3 animate-spin" />}
            {initializing ? 'Initializing...' : 'Initialize'}
          </button>
          {runner.excluded && !initializing && (
            <p className="text-xs text-outline">Runner is excluded from pool.</p>
          )}
          {!runner.excluded && runner.status !== 'online' && !initializing && (
            <p className="text-xs text-outline">Runner is {runner.status}.</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 border border-success/30 bg-success-surface p-2">
            <CheckCircle className="h-3 w-3 text-success" />
            <span className="text-xs font-mono text-success truncate">{agProjectId}</span>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="ml-auto rounded p-1 text-outline hover:bg-danger-surface hover:text-danger disabled:opacity-50"
            >
              {disconnecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleCheckStatus}
              disabled={checking}
              className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1 text-xs text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50"
            >
              {checking && <Loader2 className="h-3 w-3 animate-spin" />}
              Check Status
            </button>
            <button
              onClick={handleSyncSkills}
              disabled={syncing}
              className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1 text-xs text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50"
            >
              {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Sync Skills
            </button>
            <button
              onClick={handleInit}
              disabled={initializing}
              className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1 text-xs text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50"
            >
              {initializing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Re-init
            </button>
            {checkResult && (
              <span className={`flex items-center gap-1 text-xs ${checkResult.ok ? 'text-success' : 'text-danger'}`}>
                {checkResult.ok ? <><CheckCircle className="h-3 w-3" />OK ({checkResult.time.toFixed(1)}s)</> : <><XCircle className="h-3 w-3" />Failed</>}
              </span>
            )}
          </div>
        </div>
      )}

      {initSteps && initializing && (
        <div className="space-y-1 border border-outline-variant/20 bg-surface p-2">
          {Object.entries(STEP_LABELS).map(([key, label]) => (
            <StepIndicator key={key} label={label} status={(initSteps[key] as StepStatus) || 'pending'} />
          ))}
        </div>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
