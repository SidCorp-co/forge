// @vitest-environment jsdom
//
// ISS-1290 — a signed-out visit to a workspace address is sent to the login carrying that address;
// a deliberate sign-out is not, so the next sign-in does not go back to the page that was left.

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let pathname = '/';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
}));

const { useSignInRedirect } = await import('./use-sign-in-redirect');

beforeEach(() => {
  pathname = '/';
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  replace.mockReset();
});

describe('the redirect a signed-out visit takes', () => {
  it('carries the opened path and its query string to the login', () => {
    pathname = '/docs';
    window.history.replaceState(null, '', '/docs?path=connect-an-assistant/claude-code');

    renderHook(() => useSignInRedirect({ signedIn: false, resolved: true }));

    expect(replace).toHaveBeenCalledWith('/login?next=%2Fdocs%3Fpath%3Dconnect-an-assistant%2Fclaude-code');
  });

  it('carries nothing from the dashboard', () => {
    renderHook(() => useSignInRedirect({ signedIn: false, resolved: true }));

    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('waits while the session is still being read, and does nothing for a signed-in person', () => {
    pathname = '/docs';
    const hydrating = renderHook(() => useSignInRedirect({ signedIn: false, resolved: false }));
    hydrating.unmount();
    renderHook(() => useSignInRedirect({ signedIn: true, resolved: true }));

    expect(replace).not.toHaveBeenCalled();
  });

  it('carries nothing after a sign-out, though the page being left is still the address', () => {
    pathname = '/settings';
    const { rerender } = renderHook((p) => useSignInRedirect(p), {
      initialProps: { signedIn: true, resolved: true },
    });
    rerender({ signedIn: false, resolved: true });

    expect(replace).toHaveBeenCalledWith('/login');
  });
});
