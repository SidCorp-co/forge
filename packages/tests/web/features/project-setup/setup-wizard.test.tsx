import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { createElement, type ReactNode } from 'react';
import { WizardShell } from '@/features/project-setup/components/WizardShell';

void React;

// ---- Mocks ---------------------------------------------------------------

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...props }, children),
}));

const updateProject = vi.fn().mockResolvedValue({});

vi.mock('@/features/project/hooks/use-projects', () => ({
  projectKeys: { all: ['projects'], detail: (id: string | undefined) => ['project', id] },
  useProjectBySlug: () => ({
    id: 'p1',
    slug: 'demo',
    name: 'Demo Project',
    repoPath: null,
    baseBranch: null,
    productionBranch: null,
    defaultDeviceId: null,
    ownerId: 'u1',
  }),
  useProject: () => ({
    data: {
      id: 'p1',
      slug: 'demo',
      name: 'Demo Project',
      repoPath: null,
      baseBranch: null,
      productionBranch: null,
      defaultDeviceId: null,
      members: [{ userId: 'u1', role: 'owner' }],
      labels: [],
      devicePool: [],
    },
  }),
  useUpdateProject: () => ({
    mutateAsync: updateProject,
    isPending: false,
  }),
  useInviteProjectMember: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBindRunner: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnbindRunner: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/features/pipeline/config/hooks/use-pipeline-config', () => ({
  usePipelineConfig: () => ({
    state: {
      enabled: false,
      steps: {
        autoTriage: { enabled: false },
        autoPlan: { enabled: false },
        autoCode: { enabled: false },
        autoReview: { enabled: false },
        autoTest: { enabled: false },
        autoFix: { enabled: false },
        autoRelease: { enabled: false },
      },
      states: {},
    },
    isLoading: false,
    isSaving: false,
    isDirty: false,
    isError: false,
    flagDisabled: false,
    setField: vi.fn(),
    setStep: vi.fn(),
    setRecoveryByKind: vi.fn(),
    setStage: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    availableRunners: ['claude-code'],
    error: null,
  }),
}));

vi.mock('@/features/skill/hooks/use-skills', () => ({
  useSkills: () => ({ data: { data: [] }, isLoading: false }),
  useProjectSkillRegistrations: () => ({
    data: { registrations: [] },
    isLoading: false,
  }),
  useRegisterSkill: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnregisterSkillByStage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/features/device/hooks/use-devices', () => ({
  useMyDevices: () => ({ data: [] }),
}));

vi.mock('@/features/issue/hooks/use-issues', () => ({
  useIssues: () => ({ data: { items: [], totalCount: 0 }, isLoading: false }),
}));

vi.mock('@/features/pipeline-run/hooks/use-pipeline-runs', () => ({
  useProjectPipelineRuns: () => ({ data: { items: [], totalCount: 0 }, isLoading: false }),
}));

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  updateProject.mockClear();
});

describe('WizardShell', () => {
  it('renders all six step labels in the side stepper', () => {
    render(<WizardShell slug="demo" />, { wrapper });
    for (const label of ['Repository', 'Members', 'Pipeline', 'Skills', 'Device', 'Verify']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('starts on Repository step and saves repoPath through useUpdateProject', async () => {
    const user = userEvent.setup();
    render(<WizardShell slug="demo" />, { wrapper });

    const pathInput = screen.getByLabelText(/Repository path/i);
    await user.clear(pathInput);
    await user.type(pathInput, '/tmp/setup-wizard-test');

    await user.click(screen.getByRole('button', { name: /Save repository/i }));

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({
        id: 'p1',
        patch: {
          repoPath: '/tmp/setup-wizard-test',
          baseBranch: 'main',
          productionBranch: 'main',
        },
      });
    });
  });

  it('Skip advances the step index without committing', async () => {
    const user = userEvent.setup();
    render(<WizardShell slug="demo" />, { wrapper });
    await user.click(screen.getByRole('button', { name: /^Skip$/i }));
    // Pipeline step heading shows after Repo + Members are skipped.
    await user.click(screen.getByRole('button', { name: /^Skip$/i }));
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 2, name: /Pipeline/i }),
      ).toBeInTheDocument();
    });
  });
});
