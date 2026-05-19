'use client';

import Link from 'next/link';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { useProjectSetupState } from '../hooks/use-project-setup-state';
import { useWizardState } from '../hooks/use-wizard-state';
import { WIZARD_STEP_IDS, type WizardStepId } from '../types';
import { RepoStep } from './RepoStep';
import { MembersStep } from './MembersStep';
import { PipelineStep } from './PipelineStep';
import { SkillsStep } from './SkillsStep';
import { DeviceStep } from './DeviceStep';
import { VerifyStep } from './VerifyStep';

interface Props {
  slug: string;
}

const STEP_LABELS: Record<WizardStepId, string> = {
  repository: 'Repository',
  members: 'Members',
  pipeline: 'Pipeline',
  skills: 'Skills',
  device: 'Device',
  verify: 'Verify',
};

const STEP_DESCRIPTIONS: Record<WizardStepId, string> = {
  repository: 'Tell Forge where your code lives.',
  members: 'Invite teammates (optional).',
  pipeline: 'Enable the pipeline and pick which stages auto-run.',
  skills: 'Bind agent skills to pipeline stages.',
  device: 'Choose which devices run the agents.',
  verify: 'Send a ping to confirm everything is wired up.',
};

const SKIPPABLE_STEPS: ReadonlyArray<WizardStepId> = ['members', 'device'];

export function WizardShell({ slug }: Props) {
  const project = useProjectBySlug(slug);
  const projectId = project?.id;
  const wizard = useWizardState();
  const setup = useProjectSetupState(projectId);

  if (!project || !projectId) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <p className="text-sm text-on-surface-variant">Loading project…</p>
      </div>
    );
  }

  const stepDoneMap: Record<WizardStepId, boolean | null> = {
    repository: setup.repo,
    members: setup.members,
    pipeline: setup.pipeline,
    skills: setup.skills,
    device: setup.devices,
    verify: null,
  };

  const renderCurrentStep = () => {
    const advance = () => {
      wizard.markStep(wizard.currentStep, 'saved');
      if (!wizard.isLast) wizard.next();
    };
    switch (wizard.currentStep) {
      case 'repository':
        return <RepoStep projectId={projectId} onSaved={advance} />;
      case 'members':
        return <MembersStep projectId={projectId} />;
      case 'pipeline':
        return <PipelineStep projectId={projectId} onSaved={advance} />;
      case 'skills':
        return <SkillsStep projectId={projectId} onSaved={advance} />;
      case 'device':
        return <DeviceStep projectId={projectId} onSaved={advance} />;
      case 'verify':
        return <VerifyStep projectSlug={slug} onSaved={advance} />;
    }
  };

  return (
    <div className="min-h-screen bg-surface p-6">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6">
          <p className="text-[10px] uppercase tracking-[0.2em] text-outline">Project setup</p>
          <h1 className="text-2xl font-semibold text-on-surface mt-1">{project.name}</h1>
          <Link
            href={`/projects/${slug}`}
            className="text-xs text-outline underline hover:text-on-surface-variant"
          >
            Skip wizard and go to dashboard
          </Link>
        </header>

        <div className="grid grid-cols-[220px_1fr] gap-8">
          <nav aria-label="Setup steps" className="space-y-1">
            {WIZARD_STEP_IDS.map((id, idx) => {
              const isActive = id === wizard.currentStep;
              const status = wizard.states[id].status;
              const alreadyDone = stepDoneMap[id] === true;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => wizard.goTo(id)}
                  className={`w-full text-left flex items-center gap-3 px-3 py-2 rounded-sm text-sm ${
                    isActive
                      ? 'bg-primary/10 text-on-surface'
                      : 'text-on-surface-variant hover:bg-surface-container-low'
                  }`}
                >
                  <span
                    className={`h-5 w-5 rounded-full text-[10px] font-mono flex items-center justify-center ${
                      status === 'saved' || alreadyDone
                        ? 'bg-success text-on-primary'
                        : status === 'skipped'
                          ? 'border border-dashed border-outline text-outline'
                          : 'bg-surface-variant text-on-surface-variant'
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <span className="flex-1">{STEP_LABELS[id]}</span>
                  {alreadyDone && (
                    <span className="text-[9px] text-success uppercase tracking-wider">Done</span>
                  )}
                </button>
              );
            })}
          </nav>

          <section className="bg-surface-container-low border border-outline-variant/30 p-6">
            <div className="mb-4">
              <h2 className="text-lg font-medium text-on-surface">
                {STEP_LABELS[wizard.currentStep]}
              </h2>
              <p className="text-xs text-outline mt-1">
                {STEP_DESCRIPTIONS[wizard.currentStep]}
              </p>
              {stepDoneMap[wizard.currentStep] === true && (
                <p className="mt-2 inline-block text-[10px] uppercase tracking-wider text-success bg-success-surface/20 px-2 py-0.5 rounded-sm">
                  Already configured — you can edit or skip
                </p>
              )}
            </div>

            <div>{renderCurrentStep()}</div>

            <footer className="mt-6 flex items-center justify-between border-t border-outline-variant/20 pt-4">
              <button
                type="button"
                onClick={wizard.back}
                disabled={wizard.isFirst}
                className="text-sm text-on-surface-variant disabled:opacity-30"
              >
                ← Back
              </button>
              <div className="flex gap-2">
                {SKIPPABLE_STEPS.includes(wizard.currentStep) && (
                  <button
                    type="button"
                    onClick={() => {
                      wizard.markStep(wizard.currentStep, 'skipped');
                      wizard.next();
                    }}
                    className="text-sm text-outline hover:text-on-surface-variant"
                  >
                    Skip
                  </button>
                )}
                {!wizard.isLast && (
                  <button
                    type="button"
                    onClick={wizard.next}
                    className="text-sm text-on-surface-variant border border-outline/30 px-3 py-1 rounded-sm"
                  >
                    Next →
                  </button>
                )}
              </div>
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}
