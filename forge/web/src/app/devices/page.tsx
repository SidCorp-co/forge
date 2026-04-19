'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/layout/shell';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useAuth } from '@/providers/auth-provider';
import { projectApi } from '@/features/project/api/project-api';
import type { Device } from '@/features/project/types';

export default function DevicesPage() {
  useSetPageTitle('Devices');
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user?.isCEO) {
      router.replace('/dashboard');
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    projectApi.getDevices()
      .then((res) => setDevices(res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (authLoading || !user?.isCEO) return null;

  return (
    <Shell>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
          <div className="mb-8 border-b border-outline-variant/30 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="mb-1 text-xl font-bold sm:text-2xl text-primary tracking-tight">
                  Devices
                </h1>
                <p className="text-[10px] uppercase font-mono tracking-widest text-outline mt-1">
                  MANAGE CONNECTED DESKTOP DEVICES THAT RUN CLAUDE CLI AGENTS
                </p>
              </div>
              <div className="flex items-center gap-3">
                {syncResult && (
                  <span className="text-[10px] font-mono text-success uppercase">{syncResult}</span>
                )}
                <button
                  onClick={async () => {
                    setSyncing(true);
                    setSyncResult(null);
                    try {
                      const res = await projectApi.syncSkillsToDevices();
                      const sent = res.data.devices.filter((d) => d.sent).length;
                      setSyncResult(`${res.data.skillCount} skills → ${sent}/${res.data.devices.length} devices`);
                      setTimeout(() => setSyncResult(null), 5000);
                    } catch {
                      setSyncResult('SYNC FAILED');
                      setTimeout(() => setSyncResult(null), 3000);
                    }
                    setSyncing(false);
                  }}
                  disabled={syncing}
                  className="rounded-sm border border-outline-variant/30 bg-surface-container-low px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-primary hover:text-on-primary hover:border-transparent transition-all shadow-sm disabled:opacity-50"
                >
                  {syncing ? 'SYNCING...' : 'SYNC SKILLS'}
                </button>
              </div>
            </div>
          </div>

          {loading ? (
            <p className="text-[10px] font-mono tracking-widest uppercase text-outline-variant">LOADING DEVICES_MANIFEST...</p>
          ) : devices.length === 0 ? (
            <section className="rounded-sm border border-outline-variant/30 bg-surface p-8 text-center shadow-xl">
              <p className="text-[10px] font-bold uppercase tracking-widest text-outline">
                NO DEVICES REGISTERED. CONNECT A FORGE DESKTOP APP TO GET STARTED.
              </p>
            </section>
          ) : (
            <div className="space-y-6">
              {devices.map((d) => (
                <DeviceCard key={d.documentId} device={d} onUpdate={(updated) => {
                  setDevices((prev) => prev.map((dev) => dev.documentId === updated.documentId ? updated : dev));
                }} onDelete={(docId) => {
                  setDevices((prev) => prev.filter((dev) => dev.documentId !== docId));
                }} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function DeviceCard({ device, onUpdate, onDelete }: { device: Device; onUpdate: (d: Device) => void; onDelete: (docId: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [projectsRoot, setProjectsRoot] = useState(device.projectsRoot || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    const trimmedRoot = projectsRoot.trim();
    if (trimmedRoot && !/^\/|^[A-Za-z]:[\\\/]|^~\/|^\\\\/.test(trimmedRoot)) {
      setError('Projects root must be an absolute path');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await projectApi.updateDevice(device.documentId, {
        name: name.trim() || device.name,
        projectsRoot: trimmedRoot || null,
      });
      onUpdate({ ...device, name: name.trim() || device.name, projectsRoot: trimmedRoot || null });
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(`Failed to save: ${err}`);
    }
    setSaving(false);
  };

  const isOnline = device.lastSeen && (Date.now() - new Date(device.lastSeen).getTime()) < 5 * 60 * 1000;

  const getCountdown = useCallback(() => {
    if (!device.disabledUntil) return null;
    const diff = new Date(device.disabledUntil).getTime() - Date.now();
    if (diff <= 0) return null;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${h > 0 ? h + 'h ' : ''}${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  }, [device.disabledUntil]);

  const [countdown, setCountdown] = useState(getCountdown);
  useEffect(() => {
    if (!device.disabledUntil) return;
    const iv = setInterval(() => setCountdown(getCountdown()), 1000);
    return () => clearInterval(iv);
  }, [device.disabledUntil, getCountdown]);

  const isDisabled = !!countdown;

  return (
    <section className="rounded-sm border border-outline-variant/30 bg-surface p-5 sm:p-6 shadow-lg relative overflow-hidden">
      <div className="absolute top-0 left-0 w-1 h-full" style={{ backgroundColor: isDisabled ? 'var(--color-danger)' : isOnline ? 'var(--color-success)' : 'var(--color-outline-variant)' }} />
      <div className="flex items-start justify-between pl-2">
        <div className="flex items-center gap-3">
          <span className={`inline-block h-2 w-2 rounded-sm ${isDisabled ? 'bg-danger shadow-[0_0_8px_var(--color-danger)]' : isOnline ? 'bg-success shadow-[0_0_8px_var(--color-success)]' : 'bg-outline-variant'}`} />
          <h3 className="text-[14px] font-bold uppercase tracking-[0.2em] text-primary">{device.name}</h3>
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="text-[10px] font-mono text-success uppercase">Saved</span>}
          {!editing && (
            <>
              <button
                onClick={() => setEditing(true)}
                className="rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all shadow-sm"
              >
                EDIT
              </button>
              <button
                onClick={async () => {
                  if (!window.confirm(`Delete device "${device.name}"? It will be removed from all projects.`)) return;
                  try {
                    await projectApi.deleteDevice(device.documentId);
                    onDelete(device.documentId);
                  } catch (err) {
                    setError(`Failed to delete: ${err}`);
                  }
                }}
                className="rounded-sm border border-danger/20 bg-danger-surface px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-danger hover:bg-danger hover:text-danger-surface transition-all shadow-sm"
              >
                DELETE
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-2 text-xs text-outline pl-2">
        <div className="flex gap-4 items-center">
          <span className="text-[10px] font-bold uppercase tracking-widest text-outline-variant w-28 shrink-0">Device ID</span>
          <span className="font-mono truncate">{device.deviceId}</span>
        </div>
        <div className="flex gap-4 items-center">
          <span className="text-[10px] font-bold uppercase tracking-widest text-outline-variant w-28 shrink-0">Last seen</span>
          <span className="font-mono">{device.lastSeen ? new Date(device.lastSeen).toLocaleString() : 'NEVER'}</span>
        </div>
        {isDisabled && (
          <div className="flex gap-4 items-center">
            <span className="text-[10px] font-bold uppercase tracking-widest text-danger w-28 shrink-0">Usage limit</span>
            <span className="font-mono text-danger">RESETS IN {countdown} — {new Date(device.disabledUntil!).toLocaleString()}</span>
            <button
              onClick={async () => {
                try {
                  await projectApi.updateDevice(device.documentId, { disabledUntil: null });
                  onUpdate({ ...device, disabledUntil: null });
                } catch (err) {
                  setError(`Failed to reset: ${err}`);
                }
              }}
              className="ml-2 rounded-sm border border-danger/30 bg-danger-surface px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-danger hover:bg-danger hover:text-danger-surface transition-all"
            >
              RESET
            </button>
          </div>
        )}
        <div className="flex gap-4 items-center">
          <span className="text-[10px] font-bold uppercase tracking-widest text-outline-variant w-28 shrink-0">Projects root</span>
          <span className="font-mono text-tertiary">{device.projectsRoot || '~/forge-projects (default)'}</span>
        </div>
        {device.projectPaths && Object.keys(device.projectPaths).length > 0 && (
          <div className="mt-4 pt-4 border-t border-outline-variant/30">
            <span className="text-[10px] font-bold uppercase tracking-widest text-outline-variant">Project Paths</span>
            <div className="mt-2 space-y-1">
              {Object.entries(device.projectPaths).map(([slug, path]) => (
                <div key={slug} className="flex gap-4 text-[10px]">
                  <span className="text-outline uppercase tracking-widest w-32 shrink-0 truncate">{slug}</span>
                  <span className="font-mono text-on-surface-variant truncate">{path}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-6 space-y-5 border-t border-outline-variant/30 pt-6 pl-2">
          <div>
            <label className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Device Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-2.5 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all shadow-sm"
            />
          </div>
          <div>
            <label className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Projects Root Folder</label>
            <input
              type="text"
              value={projectsRoot}
              onChange={(e) => setProjectsRoot(e.target.value)}
              placeholder="~/forge-projects (default)"
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-2.5 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all shadow-sm font-mono"
            />
            <p className="mt-2 text-[10px] font-mono tracking-widest text-outline-variant uppercase">
              Parent directory on this device where project folders are auto-created.
            </p>
          </div>
          {error && <p className="text-[10px] font-bold uppercase tracking-widest text-danger bg-danger-surface p-2 rounded-sm border border-danger/20">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-sm bg-primary border border-transparent px-6 py-2 text-[10px] font-bold uppercase tracking-widest text-on-primary hover:bg-on-surface-variant active:scale-[0.98] disabled:opacity-50 transition-all shadow-lg"
            >
              {saving ? 'SAVING...' : 'SAVE'}
            </button>
            <button
              onClick={() => { setEditing(false); setName(device.name); setProjectsRoot(device.projectsRoot || ''); setError(''); }}
              className="rounded-sm border border-outline-variant/30 bg-surface-container-low px-6 py-2 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all shadow-sm"
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
