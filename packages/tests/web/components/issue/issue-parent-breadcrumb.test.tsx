import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { IssueParentBreadcrumb } from '@/components/issue/issue-parent-breadcrumb';

const state = vi.hoisted(() => ({
  current: { data: undefined as unknown, isLoading: false },
}));

vi.mock('@/features/issue/hooks/use-parent-chain', () => ({
  useParentChain: () => state.current,
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  } & Record<string, unknown>) => createElement('a', { href, ...rest }, children),
}));

beforeEach(() => {
  state.current = { data: undefined, isLoading: false };
});

function renderBreadcrumb() {
  return render(
    createElement(IssueParentBreadcrumb, {
      issueId: 'iss-uuid-current',
      projectSlug: 'demo',
      currentDisplayId: 'ISS-99',
    }),
  );
}

// Skipped: shared web test infra (React 19 vs jsdom render mismatch) — see
// vitest.config.ts exclude list. Re-enable when the harness is stabilised.
describe.skip('IssueParentBreadcrumb', () => {
  it('renders nothing while loading', () => {
    state.current = { data: undefined, isLoading: true };
    const { container } = renderBreadcrumb();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when chain is empty', () => {
    state.current = { data: { chain: [], truncated: false }, isLoading: false };
    const { container } = renderBreadcrumb();
    expect(container.firstChild).toBeNull();
  });

  it('renders single ancestor with link and (current) suffix', () => {
    state.current = {
      data: {
        chain: [{ id: 'p1', displayId: 'ISS-12', title: 'Parent one' }],
        truncated: false,
      },
      isLoading: false,
    };
    renderBreadcrumb();
    expect(screen.getByText('Parent:')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'ISS-12' });
    expect(link).toHaveAttribute('href', '/projects/demo/issues/ISS-12');
    expect(screen.getByText('ISS-99')).toBeInTheDocument();
    expect(screen.getByText('(current)')).toBeInTheDocument();
  });

  it('renders three ancestors in order', () => {
    state.current = {
      data: {
        chain: [
          { id: 'p1', displayId: 'ISS-1', title: 'Root' },
          { id: 'p2', displayId: 'ISS-5', title: 'Mid' },
          { id: 'p3', displayId: 'ISS-12', title: 'Immediate' },
        ],
        truncated: false,
      },
      isLoading: false,
    };
    renderBreadcrumb();
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['ISS-1', 'ISS-5', 'ISS-12']);
    expect(links[0]).toHaveAttribute('href', '/projects/demo/issues/ISS-1');
    expect(links[2]).toHaveAttribute('href', '/projects/demo/issues/ISS-12');
  });

  it('prepends ellipsis when truncated', () => {
    state.current = {
      data: {
        chain: [
          { id: 'p1', displayId: 'ISS-5', title: 'Mid' },
          { id: 'p2', displayId: 'ISS-12', title: 'Immediate' },
        ],
        truncated: true,
      },
      isLoading: false,
    };
    renderBreadcrumb();
    expect(screen.getByText('…')).toBeInTheDocument();
  });
});
