// @vitest-environment jsdom
//
// ISS-1290 — the login page reads the return address off its URL once, refuses what is not a page
// on this site by name, and hands the same answer to the password form and the OAuth links.

import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

expect.extend(matchers);

const forms: Array<{ returnTo?: string }> = [];
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ login: vi.fn() }) }));
vi.mock('@/features/auth/oauth-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/auth/oauth-api')>()),
  fetchOAuthProviders: async () => [{ id: 'github', label: 'Continue with GitHub' }],
}));
vi.mock('@/features/auth/login-form', () => ({
  LoginForm: (props: { returnTo?: string }) => {
    forms.push(props);
    return <form aria-label="password form" />;
  },
}));

const { default: LoginPage } = await import('./page');

afterEach(() => {
  cleanup();
  forms.length = 0;
});

async function open(params: Record<string, string | string[]>) {
  render(await LoginPage({ searchParams: Promise.resolve(params) }));
  const link = await screen.findByRole('link', { name: 'Continue with GitHub' });
  return new URL(link.getAttribute('href') ?? '', 'http://x').searchParams.get('redirect');
}

describe('the login page and its return address', () => {
  it('hands a page on this site to the password form and to the OAuth links', async () => {
    const redirect = await open({ next: '/docs?path=connect-an-assistant/claude-code' });

    expect(redirect).toBe('/docs?path=connect-an-assistant/claude-code');
    expect(forms.at(-1)?.returnTo).toBe('/docs?path=connect-an-assistant/claude-code');
    expect(screen.queryByText(/return address was ignored/i)).toBeNull();
  });

  it('asks for the dashboard when no return address was given, and says nothing', async () => {
    const redirect = await open({});

    expect(redirect).toBe('/');
    expect(forms.at(-1)?.returnTo).toBeUndefined();
    expect(screen.queryByText(/return address was ignored/i)).toBeNull();
  });

  it.each([['https://evil.example/x'], ['//evil.example'], ['/\\evil.example'], [['/a', '/b']]])(
    'refuses %j: the dashboard for both, and the page says the address was ignored',
    async (next) => {
      const redirect = await open({ next });

      expect(redirect).toBe('/');
      expect(forms.at(-1)?.returnTo).toBeUndefined();
      await waitFor(() => expect(screen.getByText(/return address was ignored/i)).toBeInTheDocument());
    },
  );
});

// ISS-1421 round 3 — sign-in and register say the same sentence for an agent address, from one place.
describe('the login page and an agent address', () => {
  it('shows the sentence the register page shows when an identity provider returns one', async () => {
    const { AGENT_ADDRESS_MESSAGE } = await import('@/features/auth/agent-address');
    await open({ oauth_error: 'agent_address' });

    expect(screen.getByText(AGENT_ADDRESS_MESSAGE)).toBeInTheDocument();
  });
});
