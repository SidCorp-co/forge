'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Modal } from '@/components/ui/modal';

export interface ReauthModalProps {
  open: boolean;
  pending?: boolean;
  error?: string | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function ReauthModal({
  open,
  pending = false,
  error = null,
  onSubmit,
  onCancel,
}: ReauthModalProps) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      // Auto-focus the password field on open. The Modal mounts conditionally,
      // so a ref attached after layout is the safest hook to focus from.
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!password || pending) return;
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
