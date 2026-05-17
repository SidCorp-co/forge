'use client';

import { useCallback, useContext } from 'react';
import { FreshAuthContext } from '../components/FreshAuthProvider';

/**
 * Returns an async function that opens the re-auth modal and resolves when
 * the user successfully re-verifies their password (server stamp set). If
 * the user cancels or fails, the returned promise rejects with a tagged
 * error so callers can abort their submit flow without firing the protected
 * request.
 *
 * Wraps the `FreshAuthProvider` context — the provider must be mounted on
 * any page that calls this hook (the /settings/tokens page mounts it
 * locally; other consumers will need to add it).
 */
export function useRequireFreshAuth(): () => Promise<void> {
  const ctx = useContext(FreshAuthContext);
  return useCallback(async () => {
    if (!ctx) {
      throw new Error('FreshAuthProvider missing in component tree');
    }
    return ctx.request();
  }, [ctx]);
}

export class FreshAuthCancelledError extends Error {
  constructor() {
    super('fresh auth cancelled');
    this.name = 'FreshAuthCancelledError';
  }
}
