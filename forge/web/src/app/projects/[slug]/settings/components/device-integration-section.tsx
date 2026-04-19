'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { projectApi } from '@/features/project/api/project-api';
import { skillApi } from '@/features/skill/api';
import { useAgentRunLog } from '@/features/agent/hooks/use-agent-run-log';
import type { Device } from '@/features/project/types';
import { Loader2, CheckCircle, Monitor, RefreshCw, ArrowUpFromLine } from 'lucide-react';

interface DeviceIntegrationSectionProps {
  devices: Device[];
  projectDocumentId?: string;
  projectSlug?: string;
  gitRepoUrl?: string;
}

interface DeviceInitCardProps {
  device: Device;
  projectDocumentId?: string;
  projectSlug?: string;
  gitRepoUrl?: string;
}

function DeviceInitCard({ device, projectDocumentId, projectSlug, gitRepoUrl }: DeviceInitCardProps) {
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [localPath, setLocalPath] = useState<string | null>(
    projectSlug ? (device.projectPaths?.[projectSlug] ?? null) : null,
  );
  const runLog = useAgentRunLog();
  const logEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isOnline = device.lastSeen
    ? Date.now() - new Date(device.lastSeen).getTime() < 5 * 60 * 1000
    : false;

  const isInitialized = !!localPath;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [runLog.log.length]);

  // When run completes, poll init status to update path
  useEffect(() => {
    if (!initializing || runLog.isRunning) return;
    // Run finished — check if init succeeded
    if (!projectSlug) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await projectApi.deviceInitStatus(device.documentId, projectSlug);
        if (cancelled) return;
        if (status.data?.status === 'completed') {
          setLocalPath(status.data.targetPath || projectSlug);
        }
      } catch { /* ignore */ }
      if (!cancelled) setInitializing(false);
    })();
    return () => { cancelled = true; };
  }, [runLog.isRunning, initializing, device.documentId, projectSlug]);

  const handleInit = async () => {
    if (!projectDocumentId || !projectSlug) return;
    setInitializing(true);
    setError(null);
    runLog.clear();

    try {
      const res = await projectApi.deviceInitProject(device.documentId, projectDocumentId, gitRepoUrl);
      const sessionId = res.data?.sessionId;
      if (sessionId) {
        runLog.startRun(sessionId, 'Initializing...', device.documentId);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to initialize project on device');
      setInitializing(false);
    }
  };

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const handleSyncSkills = async () => {
    if (!projectDocumentId) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await skillApi.bulkPush([`device:${device.deviceId}`], projectDocumentId);
      const results = res.data?.results || [];
      const totalPushed = results.reduce((n: number, r: any) => n + (r.pushed?.length || 0), 0);
      const errors = results.flatMap((r: any) => r.errors || []);
      if (errors.length) {
        setSyncResult(`Failed: ${errors[0]}`);
      } else {
        setSyncResult(`Synced ${totalPushed} skill(s)`);
      }
      setTimeout(() => setSyncResult(null), 3000);
    } catch (err: any) {
      setSyncResult(`Failed: ${err.message}`);
    }
    setSyncing(false);
  };

  const handleDisconnect = async () => {
    if (!projectSlug) return;
    const confirmed = window.confirm(
      `Remove project path for "${device.name}"? The files on the device will not be deleted.`,
    );
    if (!confirmed) return;

    setDisconnecting(true);
    setError(null);
    try {
      const updatedPaths = { ...(device.projectPaths || {}) };
      delete updatedPaths[projectSlug];
      await projectApi.updateDevice(device.documentId, { projectPaths: updatedPaths });
      setLocalPath(null);
    } catch (err: any) {
      setError(err.message || 'Failed to disconnect device');
    }
    setDisconnecting(false);
  };

  return (
    <div className="bg-surface-container-lowest border border-outline-variant/20 p-6 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${isOnline ? 'bg-success' : 'bg-surface-variant'}`}
            title={isOnline ? 'Online' : 'Offline'}
          />
          <span className="text-sm font-medium text-on-surface">{device.name}</span>
        </div>
      </div>

      {!isInitialized ? (
        <div className="space-y-2">
          <button
            onClick={handleInit}
            disabled={initializing || !isOnline}
            className="flex items-center gap-2 rounded bg-surface px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-container disabled:opacity-50"
          >
            {initializing && <Loader2 className="h-3 w-3 animate-spin" />}
            {initializing ? 'Initializing...' : 'Initialize'}
          </button>

          {!isOnline && !initializing && (
            <p className="text-xs text-outline">Device is offline. Connect the desktop app to initialize.</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-3 rounded border border-success/30 bg-success-surface p-2">
            <CheckCircle className="h-3.5 w-3.5 text-success shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-success">Connected</p>
              <p className="text-xs font-mono text-success truncate">{localPath}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSyncSkills}
              disabled={syncing || !isOnline}
              className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1.5 text-xs font-medium text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50"
            >
              {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpFromLine className="h-3 w-3" />}
              Sync Skills
            </button>

            <button
              onClick={handleInit}
              disabled={initializing || !isOnline}
              className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1.5 text-xs font-medium text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50"
            >
              {initializing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Re-initialize
            </button>

            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-surface disabled:opacity-50"
            >
              {disconnecting && <Loader2 className="h-3 w-3 animate-spin" />}
              Disconnect
            </button>

            {syncResult && (
              <span className={`text-xs font-mono ${syncResult.startsWith('Failed') ? 'text-danger' : 'text-success'}`}>
                {syncResult}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Agent run log — streams clone/skill output */}
      {(runLog.isRunning || runLog.log.length > 0) && (
        <div className="rounded border border-outline-variant/30 bg-surface p-3 max-h-48 overflow-y-auto">
          {runLog.status && (
            <p className={`text-xs font-medium mb-1 ${runLog.isRunning ? 'text-info' : 'text-success'}`}>
              {runLog.status}
            </p>
          )}
          <div className="space-y-0.5 font-mono text-xs text-outline">
            {runLog.log.map((line, i) => (
              <p key={i} className="break-all leading-relaxed">{line}</p>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-danger">{error}</p>
      )}
    </div>
  );
}

export function DeviceIntegrationSection({
  devices,
  projectDocumentId,
  projectSlug,
  gitRepoUrl,
}: DeviceIntegrationSectionProps) {
  if (devices.length === 0) return null;

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">06. Device Integration</h2>
        <span className="text-[9px] font-mono text-outline">DEV_EXT_06</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
      <p className="text-sm text-primary-fixed">
        Initialize desktop devices to work with this project. Creates the project folder, clones the repo, and pushes skills automatically.
      </p>

      <div className="space-y-3">
        {devices.map((device) => (
          <DeviceInitCard
            key={device.documentId}
            device={device}
            projectDocumentId={projectDocumentId}
            projectSlug={projectSlug}
            gitRepoUrl={gitRepoUrl}
          />
        ))}
      </div>
      </div>
    </section>
  );
}
