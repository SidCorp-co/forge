import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeProfile } from '@/features/me/types';
import type { OAuthProviderInfo } from '@/features/auth/api';

void React;

const useMeProfileMock = vi.fn();
const oauthProvidersMock = vi.fn();
const reauthMock = vi.fn();

vi.mock('@/features/me/hooks/use-me', () => ({
  useMeProfile: () => useMeProfileMock(),
}));

vi.mock('@/features/auth/api', () => ({
  authApi: {
    reauth: (...args: unknown[]) => reauthMock(...args),
    oauthProviders: () => oauthProvidersMock(),
  },
  oauthReauthUrl: (provider: string, returnPath: string) =>
    `http://core.test/api/auth/oauth/${provider}/reauth-start?redirect=${encodeURIComponent(returnPath)}`,
}));

// Avoid pulling in the real ApiError implementation.
vi.mock('@/lib/api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const { useRequireFreshAuth } = await import(
  '@/features/auth/hooks/use-require-fresh-auth'
);

function makeProfile(over: Partial<MeProfile>): MeProfile {
  return {
    id: 'u1',
    email: 'u@example.com',
    emailVerifiedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    hasPassword: false,
    oauthProviders: ['github'],
    lastFreshAuthAt: null,
    ...over,
  };
}

function setMe(profile: MeProfile | null) {
  useMeProfileMock.mockReturnValue({ data: profile });
}

function setProviders(providers: OAuthProviderInfo[]) {
  oauthProvidersMock.mockResolvedValue({ providers });
}

function Harness({
  onReady,
}: {
  onReady: (api: ReturnType<typeof useRequireFreshAuth>) => void;
}) {
  const api = useRequireFreshAuth();
  useEffect(() => {
    onReady(api);
  }, [api, onReady]);
  return <>{api.modal}</>;
}

function renderHarness(onReady: (api: ReturnType<typeof useRequireFreshAuth>) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Harness onReady={onReady} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useMeProfileMock.mockReset();
  oauthProvidersMock.mockReset();
  reauthMock.mockReset();
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
  // Provide a stable default; individual tests override.
  setProviders([{ id: 'github', label: 'Continue with GitHub' }]);
});

describe('useRequireFreshAuth — server freshness short-circuit', () => {
  it('resolves immediately when lastFreshAuthAt is within the client window', async () => {
    setMe(
      makeProfile({
        hasPassword: false,
        lastFreshAuthAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    let api: ReturnType<typeof useRequireFreshAuth> | null = null;
    renderHarness((x) => (api = x));
    await waitFor(() => expect(api).not.toBeNull());

    let resolved = false;
    await act(async () => {
      await api!.require().then(() => {
        resolved = true;
      });
    });
    expect(resolved).toBe(true);
  });

  it('opens the SSO modal when stamp is null and password-less', async () => {
    setMe(makeProfile({ hasPassword: false, lastFreshAuthAt: null }));

    let api: ReturnType<typeof useRequireFreshAuth> | null = null;
    const { container } = renderHarness((x) => (api = x));
    await waitFor(() => expect(api).not.toBeNull());
    await waitFor(() => expect(oauthProvidersMock).toHaveBeenCalled());

    act(() => {
      void api!.require();
    });

    await waitFor(() => {
      expect(container.textContent).toMatch(/confirm with your identity provider/i);
    });
  });

  it('opens the modal when stamp is older than the client window', async () => {
    setMe(
      makeProfile({
        hasPassword: false,
        lastFreshAuthAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
    );

    let api: ReturnType<typeof useRequireFreshAuth> | null = null;
    const { container } = renderHarness((x) => (api = x));
    await waitFor(() => expect(api).not.toBeNull());
    await waitFor(() => expect(oauthProvidersMock).toHaveBeenCalled());

    act(() => {
      void api!.require();
    });

    await waitFor(() => {
      expect(container.textContent).toMatch(/confirm with your identity provider/i);
    });
  });
});
