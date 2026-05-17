'use client';

import { useCallback, useRef, useState, type ReactElement, createElement } from 'react';
import { ApiError } from '@/lib/api/client';
import { authApi } from '../api';
import { ReauthModal } from '../components/reauth-modal';

export class ReauthCancelledError extends Error {
  constructor() {
    super('reauth cancelled');
    this.name = 'ReauthCancelledError';
  }
}

interface PendingPromise {
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface UseRequireFreshAuth {
  /** Open the modal; resolves on successful reauth, rejects on cancel. */
  require: () => Promise<void>;
  /** Element to render inside the consumer's tree so the modal can mount. */
  modal: ReactElement;
}

/**
 * Sibling children (PAT creation, device revoke) call `require()` before
 * issuing destructive requests. The promise resolves when the user re-enters
 * their password (server stamps `users.last_fresh_auth_at`), rejects with
 * `ReauthCancelledError` if they back out. Mount `modal` once at the top of
 * the consumer tree.
 */
export function useRequireFreshAuth(): UseRequireFreshAuth {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingPromise = useRef<PendingPromise | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPending(false);
    setError(null);
    pendingPromise.current = null;
  }, []);

  const require = useCallback(() => {
    return new Promise<void>((resolve, reject) => {
      pendingPromise.current = { resolve, reject };
      setError(null);
      setPending(false);
      setOpen(true);
    });
  }, []);

  const handleCancel = useCallback(() => {
    const p = pendingPromise.current;
    close();
    p?.reject(new ReauthCancelledError());
  }, [close]);

  const handleSubmit = useCallback(async (password: string) => {
    const p = pendingPromise.current;
    if (!p) return;
    setPending(true);
    setError(null);
    try {
      await authApi.reauth(password);
      setOpen(false);
      setPending(false);
      pendingPromise.current = null;
      p.resolve();
    } catch (err) {
      setPending(false);
      if (err instanceof ApiError && err.status === 401) {
        setError('Incorrect password. Try again.');
        return;
      }
      const message = err instanceof Error ? err.message : 'Reauthentication failed.';
      setError(message);
    }
  }, []);

  const modal = createElement(ReauthModal, {
    open,
    pending,
    error,
    onSubmit: handleSubmit,
    onCancel: handleCancel,
  });

  return { require, modal };
}
