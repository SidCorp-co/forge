// @vitest-environment jsdom
//
// ISS-1290 — the auth pages send a signed-in person on as soon as the session exists, which is
// before the sign-in form's own navigation lands. Sent to `/`, it threw the return address away.

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let auth = { user: null as object | null, isLoading: false };
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => auth }));

const { default: AuthLayout } = await import('./layout');

beforeEach(() => {
  auth = { user: { id: 'u1' }, isLoading: false };
});
afterEach(() => {
  cleanup();
  replace.mockReset();
  window.history.replaceState(null, '', '/');
});

function signedInAt(url: string) {
  window.history.replaceState(null, '', url);
  render(<AuthLayout>page</AuthLayout>);
}

describe('where the auth pages send a signed-in person', () => {
  it('goes to the return address on the login URL, query string intact', () => {
    signedInAt('/login?next=%2Fdocs%3Fpath%3Dconnect-an-assistant%2Fclaude-code');

    expect(replace).toHaveBeenCalledWith('/docs?path=connect-an-assistant/claude-code');
  });

  it('goes to the dashboard when the URL names none', () => {
    signedInAt('/login');

    expect(replace).toHaveBeenCalledWith('/');
  });

  it.each([['%2F%2Fevil.example'], ['https%3A%2F%2Fevil.example'], ['%2F%5Cevil.example']])(
    'goes to the dashboard, not to the refused address %s',
    (next) => {
      signedInAt(`/login?next=${next}`);

      expect(replace).toHaveBeenCalledWith('/');
    },
  );

  it('goes to the dashboard when the return address is given twice', () => {
    signedInAt('/login?next=%2Fa&next=%2Fb');

    expect(replace).toHaveBeenCalledWith('/');
  });

  it('sends nobody anywhere while the session is read or when nobody is signed in', () => {
    auth = { user: null, isLoading: false };
    signedInAt('/login?next=%2Fdocs');
    cleanup();
    auth = { user: { id: 'u1' }, isLoading: true };
    signedInAt('/login?next=%2Fdocs');

    expect(replace).not.toHaveBeenCalled();
  });
});
