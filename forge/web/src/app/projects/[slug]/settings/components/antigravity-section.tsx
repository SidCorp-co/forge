'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { projectApi } from '@/features/project/api/project-api';
import type { AntigravityRunner } from '@/features/project/types';
import { Loader2, CheckCircle, XCircle, Trash2, RefreshCw, GitBranch, ExternalLink, Plus, Server } from 'lucide-react';
import Link from 'next/link';
import { type StepStatus, STEP_LABELS, StepIndicator, CountdownTimer, ProjectRunnerCard } from './antigravity-sub-components';

const ANTIGRAVITY_MODELS = [
  { value: '', label: 'Default' },
  { value: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' },
  { value: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro (Low)' },
  { value: 'Gemini 3 Flash', label: 'Gemini 3 Flash' },
  { value: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)' },
  { value: 'Claude Opus 4.6 (Thinking)', label: 'Claude Opus 4.6 (Thinking)' },
] as const;

interface AntigravitySectionProps {
  antigravityProjectId: string;
  setAntigravityProjectId: (v: string) => void;
  antigravityModel: string;
  setAntigravityModel: (v: string) => void;
  projectDocumentId?: string;
  projectSlug?: string;
  gitRepoUrl?: string;
  antigravityError?: string | null;
  antigravityErrorAt?: string | null;
}

export function AntigravitySection({
  antigravityProjectId,
  setAntigravityProjectId,
  antigravityModel,
  setAntigravityModel,
  projectDocumentId,
  projectSlug,
  gitRepoUrl,
  antigravityError,
  antigravityErrorAt,
}: AntigravitySectionProps) {
  // Runner pool state
  const [allRunners, setAllRunners] = useState<AntigravityRunner[]>([]);
  const [projectRunnerIds, setProjectRunnerIds] = useState<string[]>([]);
  const [projectMap, setProjectMap] = useState<Record<string, string>>({});
  const [loadingRunners, setLoadingRunners] = useState(true);

  // Legacy single-instance state
  const [initializing, setInitializing] = useState(false);
  const [initSteps, setInitSteps] = useState<Record<string, StepStatus> | null>(null);
  const [initErrors, setInitErrors] = useState<Record<string, string> | null>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; count: number } | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; time: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRunners = useCallback(async () => {
    try {
      const [runnersRes, projectRes] = await Promise.all([
        projectApi.getAntigravityRunners(),
        projectDocumentId ? projectApi.getById(projectDocumentId) : null,
      ]);
      setAllRunners(runnersRes.data);
      if (projectRes?.data) {
        const proj = projectRes.data;
        setProjectRunnerIds((proj.antigravityRunners || []).map((r) => r.documentId));
        setProjectMap(proj.antigravityProjectMap || {});
      }
    } catch { /* ignore */ }
    setLoadingRunners(false);
  }, [projectDocumentId]);

  useEffect(() => { fetchRunners(); }, [fetchRunners]);

  const hasRunnerPool = loadingRunners ? true : allRunners.length > 0;
  const poolRunners = allRunners.filter((r) => projectRunnerIds.includes(r.documentId));
  const availableRunners = allRunners.filter((r) => !projectRunnerIds.includes(r.documentId));

  const handleAddToPool = async (runnerId: string) => {
    if (!projectDocumentId) return;
    const newIds = [...projectRunnerIds, runnerId];
    setProjectRunnerIds(newIds);
    try {
      await projectApi.update(projectDocumentId, {
        antigravityRunners: { connect: [runnerId] },
      } as any);
    } catch { /* ignore */ }
  };

  const handleRemoveFromPool = async (runnerId: string) => {
    if (!projectDocumentId) return;
    setProjectRunnerIds((prev) => prev.filter((id) => id !== runnerId));
    try {
      await projectApi.update(projectDocumentId, {
        antigravityRunners: { disconnect: [runnerId] },
      } as any);
    } catch { /* ignore */ }
  };

  // Persist antigravityProjectId directly to the project record
  const persistId = useCallback(async (id: string) => {
    if (!projectDocumentId) return;
    try {
      await projectApi.update(projectDocumentId, { antigravityProjectId: id || null } as any);
    } catch { /* ignore */ }
  }, [projectDocumentId]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleInit = async () => {
    setInitializing(true);
    setError(null);
    setInitSteps({ create: 'running', clone: 'pending', skills: 'pending' });
    setInitErrors(null);
    try {
      const res = await projectApi.antigravityInitProject(gitRepoUrl, projectDocumentId);
      const id = res.data?.projectId;
      if (!id) { setError('No ID returned'); setInitializing(false); return; }
      setAntigravityProjectId(id);
      persistId(id);
      setInitSteps({ create: 'done', clone: gitRepoUrl ? 'running' : 'skipped', skills: 'pending' });
      pollRef.current = setInterval(async () => {
        try {
          const status = await projectApi.antigravityInitStatus(id);
          const steps = (status.data?.steps || {}) as Record<string, StepStatus>;
          const errors = status.data?.errors || {};
          setInitSteps(steps);
          if (Object.keys(errors).length > 0) setInitErrors(errors);
          if (status.data?.status === 'done') { stopPolling(); setInitializing(false); }
        } catch { /* retry */ }
      }, 3000);
    } catch (err: any) {
      setError(err.message || 'Init failed');
      setInitializing(false);
      setInitSteps(null);
    }
  };

  const handleTest = async () => {
    if (!antigravityProjectId) return;
    setTesting(true); setTestResult(null); setError(null);
    try {
      const res = await projectApi.antigravityTestConnection(antigravityProjectId);
      setTestResult({ ok: res.data.ok, time: res.data.elapsedSeconds });
    } catch (err: any) {
      setTestResult({ ok: false, time: 0 }); setError(err.message);
    }
    setTesting(false);
  };

  const handleSyncSkills = async () => {
    if (!antigravityProjectId) return;
    setSyncing(true); setSyncResult(null); setError(null);
    try {
      const res = await projectApi.antigravitySyncSkills(antigravityProjectId, projectDocumentId);
      setSyncResult({ ok: res.data.ok, count: res.data.skillCount });
    } catch (err: any) {
      setSyncResult({ ok: false, count: 0 }); setError(err.message);
    }
    setSyncing(false);
  };

  const [deleting, setDeleting] = useState(false);
  const handleDisconnect = async () => {
    if (!antigravityProjectId) return;
    if (!window.confirm('Delete and disconnect?')) return;
    setDeleting(true); setError(null);
    try { await projectApi.antigravityDeleteProject(antigravityProjectId); } catch (err: any) {
      setError(`Delete failed: ${err.message}`);
    }
    stopPolling(); setAntigravityProjectId(''); persistId('');
    setTestResult(null); setSyncResult(null); setInitSteps(null); setInitErrors(null); setDeleting(false);
  };

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">05. Antigravity</h2>
        <span className="text-[9px] font-mono text-outline">AGR_EXT_05</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <p className="text-sm text-primary-fixed">
          Connect Antigravity runners for server-side agent execution.
          {hasRunnerPool ? ' Assign runners from the pool and initialize projects on each.' : ' Creates a project, clones your repo, and syncs skills automatically.'}
        </p>

        {/* Antigravity connection error banner */}
        {antigravityError && (
          <div className="rounded border border-danger/30 bg-danger-surface px-4 py-3">
            <div className="flex items-start gap-2">
              <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-danger">Antigravity Unavailable</p>
                <p className="text-xs text-danger/80 mt-0.5">{antigravityError}</p>
                <p className="text-[10px] text-danger/60 mt-1">
                  Pipeline steps using Antigravity are paused. Auto-checking every 5 minutes.
                  {antigravityErrorAt && ` Since ${new Date(antigravityErrorAt).toLocaleString()}`}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Runner Pool Mode */}
        {hasRunnerPool && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">Runner Pool</h3>
              <Link
                href="/antigravity"
                className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-outline hover:text-on-surface"
              >
                <ExternalLink className="h-3 w-3" />
                MANAGE RUNNERS
              </Link>
            </div>

            {/* Assigned runners */}
            {poolRunners.length > 0 ? (
              <div className="space-y-2">
                {poolRunners.map((runner) => (
                  <div key={runner.documentId} className="relative">
                    <ProjectRunnerCard
                      runner={runner}
                      projectMap={projectMap}
                      projectDocumentId={projectDocumentId}
                      gitRepoUrl={gitRepoUrl}
                      onUpdate={fetchRunners}
                    />
                    <button
                      onClick={() => handleRemoveFromPool(runner.documentId)}
                      className="absolute top-2 right-2 rounded p-1 text-outline hover:bg-danger-surface hover:text-danger"
                      title="Remove from pool"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="border border-outline-variant/20 bg-surface-container-lowest p-4 text-center">
                <Server className="mx-auto h-6 w-6 text-outline mb-2 opacity-50" />
                <p className="text-xs text-outline">No runners assigned to this project.</p>
              </div>
            )}

            {/* Add runner dropdown */}
            {availableRunners.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-outline">Add runner:</span>
                {availableRunners.map((r) => (
                  <button
                    key={r.documentId}
                    onClick={() => handleAddToPool(r.documentId)}
                    className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1 text-xs text-on-surface-variant hover:bg-surface-container-low"
                  >
                    <Plus className="h-3 w-3" />
                    {r.name}
                  </button>
                ))}
              </div>
            )}

            {/* Model selector */}
            <div className="flex items-center gap-2 pt-2 border-t border-outline-variant/10">
              <span className="text-xs text-primary-fixed">Model:</span>
              <select
                value={antigravityModel}
                onChange={(e) => setAntigravityModel(e.target.value)}
                className="bg-surface-container-high border-b border-outline rounded-none px-0 py-3 text-sm text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 w-56 appearance-none"
              >
                {ANTIGRAVITY_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Legacy Single-Instance Mode (when no runners registered) */}
        {!hasRunnerPool && (
          <>
            {!antigravityProjectId ? (
              <div className="space-y-3">
                {gitRepoUrl && (
                  <div className="flex items-center gap-2 border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-xs text-on-surface-variant">
                    <GitBranch className="h-3 w-3 shrink-0" />
                    <span className="truncate font-mono">{gitRepoUrl}</span>
                  </div>
                )}

                <button
                  onClick={handleInit}
                  disabled={initializing}
                  className="flex items-center gap-2 rounded bg-surface px-4 py-2 text-sm font-medium text-on-surface hover:bg-surface-container disabled:opacity-50"
                >
                  {initializing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {initializing ? 'Initializing...' : 'Create & Initialize Project'}
                </button>

                {initSteps && (
                  <div className="space-y-1.5 border border-outline-variant/20 bg-surface-container-lowest p-3">
                    {Object.entries(STEP_LABELS).map(([key, label]) => (
                      <StepIndicator key={key} label={label} status={(initSteps[key] as StepStatus) || 'pending'} />
                    ))}
                    {initErrors && Object.entries(initErrors).map(([step, msg]) => (
                      <p key={step} className="pl-5 text-xs text-danger">{STEP_LABELS[step]}: {msg}</p>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <span className="text-xs text-outline">or enter existing ID:</span>
                  <input
                    type="text"
                    value={antigravityProjectId}
                    onChange={(e) => setAntigravityProjectId(e.target.value)}
                    placeholder="project ID"
                    className="bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface font-mono placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors flex-1"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3 border border-success/30 bg-success-surface p-3">
                  <CheckCircle className="h-4 w-4 text-success shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-success">Connected</p>
                    <p className="text-xs font-mono text-success truncate">{antigravityProjectId}</p>
                  </div>
                  <button
                    onClick={handleDisconnect}
                    disabled={deleting}
                    className="rounded p-1.5 text-outline hover:bg-danger-surface hover:text-danger disabled:opacity-50"
                  >
                    {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </div>

                {initSteps && initializing && (
                  <div className="space-y-1.5 rounded border border-info/20 bg-info-surface/20 p-3">
                    {Object.entries(STEP_LABELS).map(([key, label]) => (
                      <StepIndicator key={key} label={label} status={(initSteps[key] as StepStatus) || 'pending'} />
                    ))}
                    {initErrors && Object.entries(initErrors).map(([step, msg]) => (
                      <p key={step} className="pl-5 text-xs text-danger">{STEP_LABELS[step]}: {msg}</p>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href="/antigravity"
                    className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1.5 text-xs font-medium text-on-surface-variant hover:bg-surface-container-low"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Instance Dashboard
                  </Link>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={handleTest} disabled={testing}
                    className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1.5 text-xs font-medium text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50">
                    {testing && <Loader2 className="h-3 w-3 animate-spin" />}
                    Test Connection
                  </button>
                  <button onClick={handleSyncSkills} disabled={syncing}
                    className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1.5 text-xs font-medium text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50">
                    {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Sync Skills
                  </button>
                  {testResult && (
                    <span className={`flex items-center gap-1 text-xs ${testResult.ok ? 'text-success' : 'text-danger'}`}>
                      {testResult.ok ? <><CheckCircle className="h-3 w-3" />OK ({testResult.time.toFixed(1)}s)</> : <><XCircle className="h-3 w-3" />Failed</>}
                    </span>
                  )}
                  {syncResult && (
                    <span className={`flex items-center gap-1 text-xs ${syncResult.ok ? 'text-success' : 'text-danger'}`}>
                      {syncResult.ok ? <><CheckCircle className="h-3 w-3" />{syncResult.count} synced</> : <><XCircle className="h-3 w-3" />Failed</>}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-primary-fixed">Model:</span>
                  <select
                    value={antigravityModel}
                    onChange={(e) => setAntigravityModel(e.target.value)}
                    className="bg-surface-container-high border-b border-outline rounded-none px-0 py-3 text-sm text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 w-56 appearance-none"
                  >
                    {ANTIGRAVITY_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </section>
  );
}
