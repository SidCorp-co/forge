import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { ApiError } from '@/lib/api/client';

// ISS-112 — verify the AlertBanner renders the correct copy for
// `STAGE_HAS_ISSUES` and falls back gracefully when the backend didn't return
// any blocking-issue payload, and that the section scrolls itself into view.

const state = vi.hoisted(() => ({
  cfgError: null as ApiError | null,
}));

const STAGES = [
  'open',
  'confirmed',
  'approved',
  'developed',
  'testing',
  'tested',
  'pass',
  'staging',
  'deploying',
  'reopen',
  'released',
] as const;

const defaultStates = Object.fromEntries(
  STAGES.map((s) => [s, { enabled: true, mode: 'auto' }]),
) as Record<string, { enabled: boolean; mode: 'auto' }>;

vi.mock('@/features/pipeline/config/hooks/use-pipeline-config', () => ({
  usePipelineConfig: () => ({
    state: { states: defaultStates },
    error: state.cfgError,
    isLoading: false,
    isSaving: false,
    isDirty: false,
    save: vi.fn(),
    setStage: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock('@/features/skill/hooks/use-skills', () => ({
  useSkills: () => ({ data: { data: [] }, isLoading: false }),
  useProjectSkillRegistrations: () => ({
    data: { registrations: [] },
    isLoading: false,
  }),
  useRegisterSkill: () => ({ mutateAsync: vi.fn(), error: null, isPending: false }),
  useUnregisterSkillByStage: () => ({
    mutateAsync: vi.fn(),
    error: null,
    isPending: false,
  }),
}));

const { SkillRegistrationsSection } = await import(
  '@/app/projects/[slug]/settings/components/skill-registrations-section'
);

beforeEach(() => {
  state.cfgError = null;
  Element.prototype.scrollIntoView = vi.fn();
});

describe('SkillRegistrationsSection — save error banner (ISS-112)', () => {
  it('renders blocking-issue count when backend supplies details.blockingIssueIds', () => {
    state.cfgError = new ApiError(409, 'cannot disable…', 'STAGE_HAS_ISSUES', {
      blockingIssueIds: ['iss-1'],
      stagesBlocked: ['deploying'],
    });
    render(
      createElement(SkillRegistrationsSection, { projectId: 'p1', isOwner: true }),
    );
    expect(screen.getByText(/Cannot disable deploying/)).toBeInTheDocument();
    expect(screen.getByText(/1 issue currently at them/)).toBeInTheDocument();
  });

  it('renders the clear fallback when blockingIssueIds is missing/empty', () => {
    state.cfgError = new ApiError(409, 'cannot disable…', 'STAGE_HAS_ISSUES', undefined);
    render(
      createElement(SkillRegistrationsSection, { projectId: 'p1', isOwner: true }),
    );
    expect(
      screen.getByText(
        /Server rejected save: stages have live issues\. Open the Issues tab/,
      ),
    ).toBeInTheDocument();
  });

  it('scrolls the banner into view when a save error surfaces', () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    state.cfgError = new ApiError(409, 'cannot disable…', 'STAGE_HAS_ISSUES', {
      blockingIssueIds: ['iss-1'],
      stagesBlocked: ['deploying'],
    });
    render(
      createElement(SkillRegistrationsSection, { projectId: 'p1', isOwner: true }),
    );
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });
});
