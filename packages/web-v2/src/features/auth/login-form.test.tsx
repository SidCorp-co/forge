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
