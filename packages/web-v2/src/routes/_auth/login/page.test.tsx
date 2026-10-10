import { afterEach, describe, expect, it, vi } from 'vitest';

const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
);
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/features/auth/login-form', () => ({ LoginForm: () => null }));
vi.mock('@/features/auth/components/social-login', () => ({ SocialLogin: () => null }));

import LoginPage from './page';

afterEach(() => {
  vi.unstubAllEnvs();
  redirect.mockClear();
});

describe('the login page in Forge previewing itself on demo data', () => {
  it('sends the browser home, never to an API route, when FORGE_DEMO_SIGNIN=1', async () => {
    // the demo web signs its member in on the server (lib/demo-signin.ts): there is no sign-in to run,
    // and a redirect to /api/auth/demo is the one the client router fetched as a page and ended blank on
    vi.stubEnv('FORGE_DEMO_SIGNIN', '1');
    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT /');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalledWith(expect.stringContaining('/api/'));
  });

  it('shows the form after a sign-out, so it is not signed straight back in', async () => {
    vi.stubEnv('FORGE_DEMO_SIGNIN', '1');
    await LoginPage({ searchParams: Promise.resolve({ session: 'ended' }) });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('is the ordinary sign-in everywhere else', async () => {
    await LoginPage({ searchParams: Promise.resolve({}) });
    expect(redirect).not.toHaveBeenCalled();
  });
});
