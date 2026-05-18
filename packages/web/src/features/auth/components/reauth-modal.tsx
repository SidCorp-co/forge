'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Modal } from '@/components/ui/modal';

export type ReauthMode = 'password' | 'sso';

export interface ReauthProviderOption {
  id: string;
  label: string;
}

export interface ReauthModalProps {
  open: boolean;
  mode?: ReauthMode;
  pending?: boolean;
  error?: string | null;
  onSubmit?: (password: string) => void;
  onSsoSelect?: (providerId: string) => void;
  onCancel: () => void;
  providers?: ReauthProviderOption[];
}

export function ReauthModal({
  open,
  mode = 'password',
  pending = false,
  error = null,
  onSubmit,
  onSsoSelect,
  onCancel,
  providers = [],
}: ReauthModalProps) {
  if (mode === 'sso') {
    return (
      <SsoReauthBody
        open={open}
        pending={pending}
        error={error}
        providers={providers}
        onSsoSelect={onSsoSelect}
        onCancel={onCancel}
      />
    );
  }
  return (
    <PasswordReauthBody
      open={open}
      pending={pending}
      error={error}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

function PasswordReauthBody({
  open,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  pending: boolean;
  error: string | null;
  onSubmit?: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!password || pending || !onSubmit) return;
    onSubmit(password);
  }

  return (
    <Modal open={open} onClose={onCancel}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
        <div>
          <h2 className="mb-1 text-xl font-black uppercase tracking-tighter text-primary">
            Confirm your password
          </h2>
          <p className="text-[11px] leading-relaxed text-on-surface-variant">
            For security, re-enter your password to continue. This unlocks
            sensitive actions for the next few minutes.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="reauth-password"
            className="text-[0.6875rem] uppercase tracking-[0.2em] text-outline"
          >
            Password
          </label>
          <input
            ref={inputRef}
            id="reauth-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
            className="rounded-sm border border-outline-variant/40 bg-surface px-3 py-1.5 text-sm text-on-surface focus:border-primary focus:outline-none disabled:opacity-50"
          />
          {error && (
            <p className="text-[11px] text-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-sm border border-outline-variant/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-outline transition-colors hover:text-on-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!password || pending}
            className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Confirm
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SsoReauthBody({
  open,
  pending,
  error,
  providers,
  onSsoSelect,
  onCancel,
}: {
  open: boolean;
  pending: boolean;
  error: string | null;
  providers: ReauthProviderOption[];
  onSsoSelect?: (providerId: string) => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel}>
      <div className="flex flex-col gap-4 p-6">
        <div>
          <h2 className="mb-1 text-xl font-black uppercase tracking-tighter text-primary">
            Confirm with your identity provider
          </h2>
          <p className="text-[11px] leading-relaxed text-on-surface-variant">
            For security, re-confirm with the provider you signed in with.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {providers.length === 0 ? (
            <p className="text-[11px] text-on-surface-variant">
              No identity provider is available for this account.
            </p>
          ) : (
            providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSsoSelect?.(p.id)}
                disabled={pending}
                className="inline-flex items-center justify-center gap-1.5 rounded-sm bg-primary px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {p.label}
              </button>
            ))
          )}
          {error && (
            <p className="text-[11px] text-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-sm border border-outline-variant/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-outline transition-colors hover:text-on-surface disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
