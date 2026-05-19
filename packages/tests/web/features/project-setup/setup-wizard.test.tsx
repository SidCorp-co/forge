import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { createElement, type ReactNode } from 'react';
import { WizardShell } from '@/features/project-setup/components/WizardShell';
import { ProjectDashboard } from '@/features/dashboard/components/project-dashboard';
import { ProjectOnboardingChecklist } from '@/features/dashboard/components/project-onboarding-checklist';
import {
  SettingsLayout,
  type SettingsGroup,
} from '@/app/projects/[slug]/settings/components/settings-layout';

void React;

// ---- Mock state (mutable, reset in beforeEach) ---------------------------

const mockState = {
  projectsHealthRow: null as null | {
    projectSlug: string;
    totalActive: number;
    throughput: number;
    pendingEscalations: number;
    statusDistribution: Record<string, number>;
    blockers: Array<{ documentId: string; issueId: string; status: string }>;
  },
  setupBooleans: {
    repo: false,
    branches: false,
    members: false,
    pipeline: false,
    skills: false,
    devices: false,
    firstIssue: false,
    firstRun: false,
  } as Record<string, boolean | null>,
  searchParams: new URLSearchParams(),
};

// ---- Mocks ---------------------------------------------------------------

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...props }, children),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'demo' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => mockState.searchParams,
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
  useProjectsHealth: () => ({
    data: mockState.projectsHealthRow ? [mockState.projectsHealthRow] : [],
    isLoading: false,
    error: null,
  }),
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

vi.mock('@/features/dashboard/hooks/use-pipeline-activity', () => ({
  usePipelineActivity: () => ({
    running: [],
    queued: [],
    recentCompleted: [],
    isLoading: false,
  }),
}));

vi.mock('@/features/dashboard/components/attention-queue', () => ({
  AttentionQueue: () => null,
}));

vi.mock('@/features/dashboard/components/pipeline-feed', () => ({
  PipelineFeed: () => null,
}));

vi.mock('@/features/dashboard/components/cost-velocity-panel', () => ({
  CostVelocityPanel: () => null,
}));

vi.mock('@/features/project-setup/hooks/use-project-setup-state', () => ({
  useProjectSetupState: () => mockState.setupBooleans,
}));

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  updateProject.mockClear();
  mockState.projectsHealthRow = null;
  mockState.setupBooleans = {
    repo: false,
    branches: false,
    members: false,
    pipeline: false,
    skills: false,
    devices: false,
    firstIssue: false,
    firstRun: false,
  };
  mockState.searchParams = new URLSearchParams();
});

// ---- WizardShell ---------------------------------------------------------

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

  it('hides the Skip button on required steps (repository, pipeline, skills, verify)', async () => {
    const user = userEvent.setup();
    render(<WizardShell slug="demo" />, { wrapper });

    // Repository step on mount — no Skip.
    expect(screen.queryByRole('button', { name: /^Skip$/i })).toBeNull();

    for (const label of ['Pipeline', 'Skills', 'Verify']) {
      const navButton = screen
        .getAllByRole('button')
        .find((b) => b.textContent?.includes(label) && !b.textContent?.includes('Save'));
      if (!navButton) throw new Error(`nav button for ${label} not found`);
      await user.click(navButton);
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { level: 2, name: new RegExp(label, 'i') }),
        ).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /^Skip$/i })).toBeNull();
    }
  });

  it('shows the Skip button on members and device steps', async () => {
    const user = userEvent.setup();
    render(<WizardShell slug="demo" />, { wrapper });

    for (const label of ['Members', 'Device']) {
      const navButton = screen
        .getAllByRole('button')
        .find((b) => b.textContent?.includes(label) && !b.textContent?.includes('Save'));
      if (!navButton) throw new Error(`nav button for ${label} not found`);
      await user.click(navButton);
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { level: 2, name: new RegExp(label, 'i') }),
        ).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /^Skip$/i })).toBeInTheDocument();
    }
  });

  it('Skip on members advances to the pipeline step', async () => {
    const user = userEvent.setup();
    render(<WizardShell slug="demo" />, { wrapper });

    const membersNav = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('Members') && !b.textContent?.includes('Save'));
    if (!membersNav) throw new Error('Members nav button not found');
    await user.click(membersNav);

    await user.click(screen.getByRole('button', { name: /^Skip$/i }));
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 2, name: /Pipeline/i }),
      ).toBeInTheDocument();
    });
  });

  it('PipelineStep Save button is enabled when the form is clean', async () => {
    const user = userEvent.setup();
    render(<WizardShell slug="demo" />, { wrapper });

    const pipelineNav = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('Pipeline') && !b.textContent?.includes('Save'));
    if (!pipelineNav) throw new Error('Pipeline nav button not found');
    await user.click(pipelineNav);

    const save = await screen.findByRole('button', { name: /Save pipeline/i });
    expect(save).not.toBeDisabled();
  });
});

// ---- ProjectDashboard banner --------------------------------------------

describe('ProjectDashboard ContinueSetupBanner mounting', () => {
  it('renders the banner above the full active-project layout when a gap exists', () => {
    mockState.projectsHealthRow = {
      projectSlug: 'demo',
      totalActive: 5,
      throughput: 3,
      pendingEscalations: 0,
      statusDistribution: { open: 5 },
      blockers: [],
    };
    mockState.setupBooleans = {
      ...mockState.setupBooleans,
      repo: true,
      branches: true,
      members: false,
      pipeline: false,
      skills: false,
      devices: false,
    };

    render(<ProjectDashboard />, { wrapper });

    expect(screen.getByText(/Continue project setup/i)).toBeInTheDocument();
    // Full layout grid sibling — stat cards are present.
    expect(screen.getByText(/Active issues/i)).toBeInTheDocument();
  });

  it('self-hides the banner when all required setup flags are true', () => {
    mockState.projectsHealthRow = {
      projectSlug: 'demo',
      totalActive: 1,
      throughput: 0,
      pendingEscalations: 0,
      statusDistribution: { open: 1 },
      blockers: [],
    };
    mockState.setupBooleans = {
      ...mockState.setupBooleans,
      repo: true,
      branches: true,
      pipeline: true,
      skills: true,
      devices: true,
    };

    render(<ProjectDashboard />, { wrapper });

    expect(screen.queryByText(/Continue project setup/i)).toBeNull();
    expect(screen.getByText(/Active issues/i)).toBeInTheDocument();
  });
});

// ---- ProjectOnboardingChecklist loading state ----------------------------

describe('ProjectOnboardingChecklist loading state', () => {
  it('renders an indeterminate spinner row (no CTA) while booleans are null', () => {
    mockState.setupBooleans = {
      repo: null,
      branches: null,
      members: null,
      pipeline: null,
      skills: null,
      devices: null,
      firstIssue: null,
      firstRun: null,
    };

    const { container } = render(
      <ProjectOnboardingChecklist slug="demo" projectId="p1" />,
      { wrapper },
    );

    expect(container.querySelectorAll('[data-testid^="checklist-loading-"]').length).toBe(8);
    // No CTA anchors while loading.
    expect(container.querySelector('a')).toBeNull();
  });
});

// ---- SettingsLayout deep-link alias resolution ---------------------------

function buildGroups(): SettingsGroup[] {
  const make = (id: string, label: string) => ({
    id,
    label,
    tag: id.slice(0, 6).toUpperCase(),
    render: () => createElement('section', { 'data-testid': `panel-${id}` }, label),
  });
  return [
    {
      label: 'Identity',
      items: [
        make('identity.basics', 'Basics'),
        make('identity.repo', 'Repository'),
        make('identity.members', 'Members'),
        make('identity.devices', 'Devices'),
      ],
    },
    {
      label: 'Pipeline',
      items: [make('pipeline.config', 'Configuration'), make('pipeline.skills', 'Skills')],
    },
  ];
}

describe('SettingsLayout deep-link aliases', () => {
  const aliasCases: Array<[string, string]> = [
    ['repo', 'identity.repo'],
    ['basics', 'identity.basics'],
    ['members', 'identity.members'],
    ['devices', 'identity.devices'],
    ['pipeline', 'pipeline.config'],
    ['skills', 'pipeline.skills'],
  ];

  for (const [alias, canonical] of aliasCases) {
    it(`resolves ?section=${alias} to ${canonical}`, () => {
      mockState.searchParams = new URLSearchParams(`section=${alias}`);
      const { getByTestId } = render(
        <SettingsLayout groups={buildGroups()} defaultSectionId="identity.basics" />,
      );
      expect(getByTestId(`panel-${canonical}`)).toBeInTheDocument();
    });
  }

  it('falls back to defaultSectionId for an unknown ?section= value', () => {
    mockState.searchParams = new URLSearchParams('section=zzz');
    const { getByTestId } = render(
      <SettingsLayout groups={buildGroups()} defaultSectionId="identity.basics" />,
    );
    expect(getByTestId('panel-identity.basics')).toBeInTheDocument();
  });
});
