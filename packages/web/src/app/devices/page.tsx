'use client';

import { Check, Copy, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Shell } from '@/components/layout/shell';
import { Button, Modal } from '@/components/ui';
import {
  useMintPairingCode,
  useMyDevices,
  useRenameDevice,
  useRevokeDevice,
} from '@/features/device/hooks/use-devices';
import type { MyDevice } from '@/features/device/types';
import { useProjects } from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';

const STATUS_PILLS: Record<MyDevice['status'], string> = {
  online: 'bg-success-surface text-success border-success/30',
  offline: 'bg-surface-container-high text-on-surface-variant border-outline-variant/30',
  revoked: 'bg-danger-surface text-danger border-danger/30',
};

function formatRelative(iso: string | Date | null): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return d.toLocaleDateString();
}

export default function DevicesPage() {
  useSetPageTitle('Devices');
  const { data: devices, isLoading, error } = useMyDevices();
  const [pairOpen, setPairOpen] = useState(false);

  return (
    <Shell>
      <div className="flex h-full flex-col overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-on-surface">Devices</h1>
          <p className="mt-1 text-xs text-outline">
            Desktop agents paired to your account. Revoking a device blocks future heartbeats and
            removes it from every project pool.
          </p>
        </div>
        <Button onClick={() => setPairOpen(true)} size="sm">
          <Plus className="h-4 w-4" />
          Pair new device
        </Button>
      </div>

      {error && (
        <div className="rounded border border-danger/40 bg-danger-surface/40 p-3 text-sm text-danger">
          Failed to load devices.
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-outline">Loading devices…</p>
      )}

      {!isLoading && devices && devices.length === 0 && (
        <div className="rounded-sm border border-outline-variant/30 bg-surface-container-low p-12 text-center">
          <p className="text-sm text-on-surface-variant">No devices paired yet.</p>
          <p className="mt-2 text-xs text-outline">
            Click <span className="font-medium">Pair new device</span> to mint a code, then run
            the desktop agent and paste the code in.
          </p>
        </div>
      )}

      {devices && devices.length > 0 && (
        <div className="overflow-hidden rounded-sm border border-outline-variant/30 bg-surface-container-low">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant/20 text-[10px] uppercase tracking-[0.15em] text-outline">
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Platform</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Last seen</th>
                <th className="px-4 py-3 text-left font-medium">Paired</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <DeviceRow key={d.id} device={d} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PairDeviceModal open={pairOpen} onClose={() => setPairOpen(false)} />
      </div>
    </Shell>
  );
}

function DeviceRow({ device }: { device: MyDevice }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const rename = useRenameDevice();
  const revoke = useRevokeDevice();
  const isRevoked = device.status === 'revoked';

  const onSave = async () => {
    if (!name.trim() || name === device.name) {
      setEditing(false);
      setName(device.name);
      return;
    }
    await rename.mutateAsync({ id: device.id, name: name.trim() });
    setEditing(false);
  };

  const onRevoke = async () => {
    if (!window.confirm(`Revoke "${device.name}"? Future heartbeats will be rejected.`)) return;
    await revoke.mutateAsync({ id: device.id });
  };

  return (
    <tr className="border-b border-outline-variant/10 last:border-b-0">
      <td className="px-4 py-3">
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onSave();
                if (e.key === 'Escape') {
                  setEditing(false);
                  setName(device.name);
                }
              }}
              className="bg-transparent border-b border-outline/30 py-1 text-sm focus:outline-none focus:border-primary"
            />
            <button type="button" onClick={() => void onSave()} className="text-success">
              <Check className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setName(device.name);
              }}
              className="text-outline"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className={isRevoked ? 'text-outline line-through' : 'text-on-surface'}>
              {device.name}
            </span>
            {!isRevoked && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-outline hover:text-on-surface"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-on-surface-variant capitalize">{device.platform}</td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${STATUS_PILLS[device.status]}`}
        >
          {device.status}
        </span>
      </td>
      <td className="px-4 py-3 text-on-surface-variant">{formatRelative(device.lastSeenAt)}</td>
      <td className="px-4 py-3 text-on-surface-variant">{formatRelative(device.pairedAt)}</td>
      <td className="px-4 py-3 text-right">
        {!isRevoked && (
          <button
            type="button"
            onClick={() => void onRevoke()}
            disabled={revoke.isPending}
            className="text-danger hover:opacity-80 disabled:opacity-50"
            aria-label="Revoke device"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </td>
    </tr>
  );
}

function PairDeviceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: projects, isLoading } = useProjects();
  const [projectId, setProjectId] = useState<string>('');
  const mint = useMintPairingCode();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const onMint = async () => {
    if (!projectId) return;
    const res = await mint.mutateAsync({ projectId });
    setCode(res);
  };

  const onCopy = () => {
    if (!code) return;
    void navigator.clipboard.writeText(code.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const reset = () => {
    setProjectId('');
    setCode(null);
    setCopied(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={reset}>
      <div className="p-6 space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">Pair new device</h2>
          <p className="mt-1 text-xs text-outline">
            Mint a one-time code (5-min TTL). Run the desktop agent on the target machine and
            paste the code when prompted.
          </p>
        </div>

        {!code && (
          <>
            <div>
              <label
                htmlFor="pair-project"
                className="mb-1 block text-sm font-medium text-on-surface-variant"
              >
                Project
              </label>
              <select
                id="pair-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={isLoading}
                className="w-full bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface focus:outline-none focus:border-b-primary"
              >
                <option value="">Select a project…</option>
                {projects?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-[10px] text-outline">
                The new device will auto-bind to this project on first heartbeat.
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
              <Button onClick={() => void onMint()} disabled={!projectId || mint.isPending}>
                {mint.isPending ? 'Minting…' : 'Mint pairing code'}
              </Button>
            </div>
          </>
        )}

        {code && (
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-[10px] uppercase tracking-[0.15em] font-bold text-on-surface-variant">
                Pairing code
              </p>
              <div className="flex items-center gap-3 rounded-sm border border-outline-variant/30 bg-surface-container-high px-4 py-3">
                <code className="flex-1 font-mono text-lg tracking-widest text-on-surface">
                  {code.code}
                </code>
                <button
                  type="button"
                  onClick={onCopy}
                  className="text-on-surface-variant hover:text-on-surface"
                  aria-label="Copy code"
                >
                  {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-2 text-[10px] text-outline">
                Expires {new Date(code.expiresAt).toLocaleTimeString()}.
              </p>
            </div>

            <div className="flex justify-end">
              <Button onClick={reset}>Done</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
