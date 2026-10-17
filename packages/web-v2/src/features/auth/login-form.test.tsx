// @vitest-environment jsdom
//
// ISS-1290 — signing in returned every person to the dashboard, whatever address they had opened.

import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

expect.extend(matchers);

const push = vi.fn();
const login = vi.fn(async () => {});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ login }) }));

const { LoginForm } = await import('./login-form');

afterEach(() => {
  cleanup();
  push.mockReset();
  login.mockClear();
});

async function signIn(ui: React.ReactElement) {
  render(ui);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(login).toHaveBeenCalled());
}

describe('where the sign-in form goes once the person is signed in', () => {
  it('goes to the address it was given, query string intact', async () => {
    await signIn(<LoginForm returnTo="/docs?path=connect-an-assistant/claude-code" />);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/docs?path=connect-an-assistant/claude-code'));
  });

  it('goes to the dashboard when it was given none', async () => {
    await signIn(<LoginForm />);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
  });

  it('does not navigate when the sign-in is refused', async () => {
    login.mockRejectedValueOnce(new Error('Invalid credentials'));
    render(<LoginForm returnTo="/docs" />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password-here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Invalid credentials');
    expect(push).not.toHaveBeenCalled();
  });
});

// ISS-1421 r4 — sign-in and register show one sentence for a rate-limited attempt.
describe("the sign-in form's refusal by its rate limit", () => {
  it('says when to try again, in the sentence register shows', async () => {
    const { ApiError } = await import('@/lib/api/client');
    const { rateLimitedSentence } = await import('./rate-limit-words');
    login.mockRejectedValueOnce(
      new ApiError(429, 'rate limit exceeded', 'RATE_LIMITED', { retryAfterSeconds: 61 }),
    );
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Too many attempts from this network. Try again in 2 minutes.');
    expect(rateLimitedSentence({ retryAfterSeconds: 61 })).toBe(
      'Too many attempts from this network. Try again in 2 minutes.',
    );
    expect(screen.queryByText('rate limit exceeded')).not.toBeInTheDocument();
  });

  it('says a moment where the answer names no wait', async () => {
    const { rateLimitedSentence } = await import('./rate-limit-words');
    expect(rateLimitedSentence(undefined)).toBe(
      'Too many attempts from this network. Wait a moment, then try again.',
    );
    expect(rateLimitedSentence({ retryAfterSeconds: 30 })).toBe(
      'Too many attempts from this network. Try again in 30 seconds.',
    );
    expect(rateLimitedSentence({ retryAfterSeconds: 7200 })).toBe(
      'Too many attempts from this network. Try again in 2 hours.',
    );
  });
});
