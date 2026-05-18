'use client';

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  createElement,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/client';
import { useMeProfile } from '@/features/me/hooks/use-me';
import { authApi, oauthReauthUrl, type OAuthProviderInfo } from '../api';
import {
  ReauthModal,
  type ReauthMode,
  type ReauthProviderOption,
} from '../components/reauth-modal';

export class ReauthCancelledError extends Error {
  constructor() {
    super('reauth cancelled');
    this.name = 'ReauthCancelledError';
  }
}

export class ReauthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReauthUnavailableError';
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
 * issuing destructive requests. Password users see the password modal;
 * password-less SSO users see a provider button that bounces them through
 * their existing OAuth flow with `mode: 'reauth'`. The callback stamps
 * `users.last_fresh_auth_at` server-side; on return, the browser lands back
 * on the same page with `?reauth=ok`. Mount `modal` once at the top of the
 * consumer tree.
 */
export function useRequireFreshAuth(): UseRequireFreshAuth {
  const me = useMeProfile();
  const oauthProviderList = useQuery({
    queryKey: ['auth', 'oauth-providers'] as const,
    queryFn: () => authApi.oauthProviders(),
    staleTime: 5 * 60_000,
  });

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ReauthMode>('password');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingPromise = useRef<PendingPromise | null>(null);

  const ssoProviders = useMemo<ReauthProviderOption[]>(() => {
    const enabled = oauthProviderList.data?.providers ?? [];
    const linked = me.data?.oauthProviders ?? [];
    if (!enabled.length || !linked.length) return [];
    const enabledById = new Map<string, OAuthProviderInfo>(
      enabled.map((p) => [p.id, p]),
    );
    const out: ReauthProviderOption[] = [];
    for (const id of linked) {
      const cfg = enabledById.get(id);
      if (cfg) out.push({ id: cfg.id, label: cfg.label });
    }
    return out;
  }, [oauthProviderList.data, me.data]);

  const close = useCallback(() => {
    setOpen(false);
    setPending(false);
    setError(null);
    pendingPromise.current = null;
  }, []);

  const require = useCallback(() => {
    return new Promise<void>((resolve, reject) => {
      const profile = me.data;
      // If `me` hasn't loaded yet we still default to the password modal —
      // the server gate is the source of truth either way, and a stale tab
      // is the only realistic way to reach this branch.
      const hasPassword = profile?.hasPassword ?? true;
      const linkedProviders = profile?.oauthProviders ?? [];

      if (hasPassword) {
        pendingPromise.current = { resolve, reject };
        setError(null);
        setPending(false);
        setMode('password');
        setOpen(true);
        return;
      }

      // Password-less account — find a provider button to offer.
      const enabled = oauthProviderList.data?.providers ?? [];
      const enabledIds = new Set(enabled.map((p) => p.id));
      const usable = linkedProviders.filter((id) => enabledIds.has(id));
      if (usable.length === 0) {
        reject(
          new ReauthUnavailableError(
            'No re-confirmation method available. Set a password in account settings.',
          ),
        );
        return;
      }

      pendingPromise.current = { resolve, reject };
      setError(null);
      setPending(false);
      setMode('sso');
      setOpen(true);
    });
  }, [me.data, oauthProviderList.data]);

  const handleCancel = useCallback(() => {
    const p = pendingPromise.current;
    close();
    p?.reject(new ReauthCancelledError());
  }, [close]);

  const handlePasswordSubmit = useCallback(async (password: string) => {
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

  const handleSsoSelect = useCallback((providerId: string) => {
    // The promise stays pending — the page is about to navigate away. On
    // return the user lands on `?reauth=ok` and will trigger `require()`
    // again from a fresh page load.
    setPending(true);
    const returnPath = window.location.pathname + window.location.search;
    window.location.assign(oauthReauthUrl(providerId, returnPath));
  }, []);

  const modal = createElement(ReauthModal, {
    open,
    mode,
    pending,
    error,
    providers: ssoProviders,
    onSubmit: handlePasswordSubmit,
    onSsoSelect: handleSsoSelect,
    onCancel: handleCancel,
  });

  return { require, modal };
}
