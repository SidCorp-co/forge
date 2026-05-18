import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReauthModal } from '@/features/auth/components/reauth-modal';

void React;

describe('ReauthModal — password mode (default)', () => {
  it('renders the password heading and form', () => {
    render(
      <ReauthModal
        open={true}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/confirm your password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('calls onSubmit with the typed password', () => {
    const onSubmit = vi.fn();
    render(
      <ReauthModal
        open={true}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onSubmit).toHaveBeenCalledWith('hunter2');
  });
});

describe('ReauthModal — sso mode', () => {
  it('shows the identity-provider heading + one button per provider', () => {
    render(
      <ReauthModal
        open={true}
        mode="sso"
        providers={[
          { id: 'google', label: 'Continue with Google' },
          { id: 'github', label: 'Continue with GitHub' },
        ]}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/confirm with your identity provider/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with github/i })).toBeInTheDocument();
    // No password input in sso mode.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it('fires onSsoSelect with the chosen provider id', () => {
    const onSsoSelect = vi.fn();
    render(
      <ReauthModal
        open={true}
        mode="sso"
        providers={[{ id: 'google', label: 'Continue with Google' }]}
        onSsoSelect={onSsoSelect}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    expect(onSsoSelect).toHaveBeenCalledWith('google');
  });

  it('renders a fallback message when no providers are passed', () => {
    render(
      <ReauthModal open={true} mode="sso" providers={[]} onCancel={() => {}} />,
    );
    expect(
      screen.getByText(/no identity provider is available/i),
    ).toBeInTheDocument();
  });
});
