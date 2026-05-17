'use client';

import { createContext, useCallback, useRef, useState, type ReactNode } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { tokenApi } from '../api';
import { FreshAuthCancelledError } from '../hooks/use-fresh-auth';

interface FreshAuthContextValue {
  request: () => Promise<void>;
}

export const FreshAuthContext = createContext<FreshAuthContextValue | null>(null);

interface PendingPromise {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Backend freshness window is 5 minutes (see `requireFreshAuth(5)` on PAT
 * routes). Shave a 30s safety buffer off the client cache so we never resolve
 * silently on a stamp that's about to expire mid-request.
 */
const FRESH_WINDOW_MS = 5 * 60 * 1000;
const FRESH_SAFETY_BUFFER_MS = 30 * 1000;

export function FreshAuthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<PendingPromise | null>(null);
  const stampedAtRef = useRef<number | null>(null);

  const request = useCallback<FreshAuthContextValue['request']>(() => {
    const stampedAt = stampedAtRef.current;
    if (
      stampedAt !== null &&
      Date.now() - stampedAt < FRESH_WINDOW_MS - FRESH_SAFETY_BUFFER_MS
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      pendingRef.current = { resolve, reject };
      setPassword('');
      setError(null);
      setSubmitting(false);
      setOpen(true);
    });
  }, []);

  function cancel() {
    pendingRef.current?.reject(new FreshAuthCancelledError());
    pendingRef.current = null;
    setOpen(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    setError(null);
    try {
      const { stampedAt } = await tokenApi.reauth(password);
      const parsed = Date.parse(stampedAt);
      stampedAtRef.current = Number.isFinite(parsed) ? parsed : Date.now();
      pendingRef.current?.resolve();
      pendingRef.current = null;
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Incorrect password. Please try again.');
      } else {
        setError(formatApiError(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FreshAuthContext.Provider value={{ request }}>
      {children}
      <Modal open={open} onClose={cancel}>
        <form onSubmit={submit} className="p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-surface-container-highest">
              <ShieldCheck className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-tight text-primary">
                Confirm your password
              </h2>
              <p className="text-[10px] uppercase tracking-widest text-outline">
                Required for sensitive actions
              </p>
            </div>
          </div>
          <p className="mb-4 text-sm text-on-surface-variant">
            For your security, please re-enter your password to continue. This
            confirmation stays valid for 5 minutes.
          </p>
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-outline">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            className="w-full rounded-sm border border-outline-variant/40 bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
            disabled={submitting}
          />
          {error && <p className="mt-2 text-[12px] text-error">{error}</p>}
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={cancel}
              disabled={submitting}
              className="rounded-sm border border-outline-variant/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !password}
              className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Confirm
            </button>
          </div>
        </form>
      </Modal>
    </FreshAuthContext.Provider>
  );
}
