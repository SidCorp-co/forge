'use client';

import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { useProjects } from '@/features/project/hooks/use-projects';
import {
  ReauthCancelledError,
  ReauthUnavailableError,
} from '@/features/auth/hooks/use-require-fresh-auth';
import { useCreateToken } from '../hooks/use-tokens';
import type { CreatePatInput, PatScope, PatWithPlaintext } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (token: PatWithPlaintext) => void;
  requireFreshAuth: () => Promise<void>;
}

type ScopePreset = 'read' | 'standard' | 'admin';
type ExpiryPreset = '30' | '90' | '365' | 'never';

const SCOPE_MAP: Record<ScopePreset, PatScope[]> = {
  read: ['read'],
  standard: ['read', 'write'],
  admin: ['admin'],
};

function expiryToIso(preset: ExpiryPreset): string | undefined {
  if (preset === 'never') return undefined;
  const days = Number(preset);
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function CreateTokenModal({ open, onClose, onCreated, requireFreshAuth }: Props) {
  return (
    <Modal open={open} onClose={onClose}>
      {open && (
        <CreateTokenForm
          onClose={onClose}
          onCreated={onCreated}
          requireFreshAuth={requireFreshAuth}
        />
      )}
    </Modal>
  );
}

function CreateTokenForm({
  onClose,
  onCreated,
  requireFreshAuth,
}: {
  onClose: () => void;
  onCreated: (token: PatWithPlaintext) => void;
  requireFreshAuth: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ScopePreset>('standard');
  const [expiry, setExpiry] = useState<ExpiryPreset>('90');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const projects = useProjects();
  const createToken = useCreateToken();

  const resolvedScopes: PatScope[] = SCOPE_MAP[scope];

  function toggleProject(id: string) {
    setProjectIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }

    setSubmitting(true);
    try {
      await requireFreshAuth();
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ReauthCancelledError) return;
      if (err instanceof ReauthUnavailableError) {
        setError(err.message);
        return;
      }
      setError(formatApiError(err));
      return;
    }

    try {
      const payload: CreatePatInput = {
        name: name.trim(),
        scopes: resolvedScopes,
        projectIds: projectIds.length > 0 ? projectIds : null,
        expiresAt: expiryToIso(expiry) ?? null,
      };
      const token = await createToken.mutateAsync(payload);
      onCreated(token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.code === 'PAT_LIMIT') {
        const max = (err.details as { max?: number } | undefined)?.max;
        setError(
          max
            ? `You have reached the maximum of ${max} active tokens. Revoke one before creating another.`
            : 'Token limit reached. Revoke one before creating another.',
        );
      } else if (err instanceof ApiError && err.code === 'PAT_NAME_CONFLICT') {
        setError('A token with this name already exists. Choose a different name.');
      } else if (err instanceof ApiError && err.code === 'FRESH_AUTH_REQUIRED') {
        setError('Re-authentication expired. Please try again.');
      } else {
        setError(formatApiError(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-surface-container-highest">
          <Plus className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight text-primary">
            Create personal access token
          </h2>
          <p className="text-[10px] uppercase tracking-widest text-outline">
            MCP & API authentication
          </p>
        </div>
      </div>

      <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-outline">
        Name
      </label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        required
        placeholder="e.g. Local development laptop"
        className="mb-4 w-full rounded-sm border border-outline-variant/40 bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
      />

      <fieldset className="mb-4">
        <legend className="mb-1 text-[10px] font-bold uppercase tracking-widest text-outline">
          Scope
        </legend>
        <div className="space-y-1.5">
          <label className="flex items-start gap-2 text-sm text-on-surface">
            <input
              type="radio"
              name="scope"
              value="read"
              checked={scope === 'read'}
              onChange={() => setScope('read')}
              className="mt-1"
            />
            <div>
              <p>Read-only</p>
              <p className="font-mono text-[10px] text-outline">{"['read']"}</p>
            </div>
          </label>
          <label className="flex items-start gap-2 text-sm text-on-surface">
            <input
              type="radio"
              name="scope"
              value="standard"
              checked={scope === 'standard'}
              onChange={() => setScope('standard')}
              className="mt-1"
            />
            <div>
              <p>Standard (read + write)</p>
              <p className="font-mono text-[10px] text-outline">{"['read', 'write']"}</p>
            </div>
          </label>
          <label className="flex items-start gap-2 text-sm text-on-surface">
            <input
              type="radio"
              name="scope"
              value="admin"
              checked={scope === 'admin'}
              onChange={() => setScope('admin')}
              className="mt-1"
            />
            <div>
              <p>Admin</p>
              <p className="font-mono text-[10px] text-outline">{"['admin']"}</p>
              <p className="text-[10px] text-outline">
                Legacy elevated scope, kept for compatibility. MCP tool access is governed by your
                role on each project (owner/admin/member) — this scope grants no extra cross-tenant
                access.
              </p>
            </div>
          </label>
        </div>
        {scope === 'admin' && (
          <p className="mt-2 text-[10px] text-outline">
            The project allowlist below still narrows which projects this token can access.
          </p>
        )}
      </fieldset>

      <fieldset className="mb-4">
        <legend className="mb-1 text-[10px] font-bold uppercase tracking-widest text-outline">
          Projects
        </legend>
        {projects.isLoading ? (
          <p className="text-[12px] text-outline">Loading projects…</p>
        ) : (projects.data ?? []).length === 0 ? (
          <p className="text-[12px] text-outline">No projects available.</p>
        ) : (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-sm border border-outline-variant/20 p-2">
            {projects.data?.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm text-on-surface">
                <input
                  type="checkbox"
                  checked={projectIds.includes(p.id)}
                  onChange={() => toggleProject(p.id)}
                />
                <span>{p.name}</span>
                <span className="font-mono text-[10px] text-outline">{p.slug}</span>
              </label>
            ))}
          </div>
        )}
        <p className="mt-1 text-[10px] text-outline">
          Leave empty to grant access to all projects you can access.
        </p>
      </fieldset>

      <fieldset className="mb-4">
        <legend className="mb-1 text-[10px] font-bold uppercase tracking-widest text-outline">
          Expires
        </legend>
        <div className="grid grid-cols-4 gap-2">
          {(
            [
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
              { value: '365', label: '1 year' },
              { value: 'never', label: 'No expiry' },
            ] as const
          ).map((o) => (
            <label
              key={o.value}
              className={`cursor-pointer rounded-sm border px-2 py-1.5 text-center text-[11px] font-bold uppercase tracking-widest ${
                expiry === o.value
                  ? 'border-primary bg-surface-variant text-primary'
                  : 'border-outline-variant/40 text-outline hover:bg-surface-container-high'
              }`}
            >
              <input
                type="radio"
                name="expiry"
                value={o.value}
                checked={expiry === o.value}
                onChange={() => setExpiry(o.value)}
                className="sr-only"
              />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>

      {error && <p className="mb-3 text-[12px] text-error">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-sm border border-outline-variant/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Create token
        </button>
      </div>
    </form>
  );
}
