'use client';

import { useMemo } from 'react';
import { useAppConfig } from '@/features/app-config/hooks/use-app-config';
import { usePipelineConfig } from '@/features/pipeline/config/hooks/use-pipeline-config';
import { useProject } from '@/features/project/hooks/use-projects';
import { useProjectSkillRegistrations } from '@/features/skill/hooks/use-skills';
import { STAGE_NAMES } from '@/features/pipeline/config/types';

export interface ConfigHealthIssue {
  /** Matches a SettingsLayout section ID for deep-linking. */
  section: string;
  /** Matches a `data-config-health-target` attribute for scroll-into-view. */
  field: string;
  message: string;
}

export interface ConfigHealthResult {
  status: 'ok' | 'warn';
  issues: ConfigHealthIssue[];
}

export function useConfigHealth(projectId: string | undefined): ConfigHealthResult {
  const project = useProject(projectId);
  const appConfig = useAppConfig(projectId);
  const pipeline = usePipelineConfig(projectId);
  const registrations = useProjectSkillRegistrations(projectId);

  return useMemo<ConfigHealthResult>(() => {
    const issues: ConfigHealthIssue[] = [];
    const p = project.data;
    const cfg = appConfig.data;

    if (p) {
      if (!p.repoPath || p.repoPath.trim().length === 0) {
        issues.push({
          section: 'identity.repo',
          field: 'repo.repoPath',
          message: 'Repository path is empty.',
        });
      }
      if (!p.baseBranch || p.baseBranch.trim().length === 0) {
        issues.push({
          section: 'identity.repo',
          field: 'repo.baseBranch',
          message: 'Base branch is empty.',
        });
      }
      if (!p.productionBranch || p.productionBranch.trim().length === 0) {
        issues.push({
          section: 'identity.repo',
          field: 'repo.productionBranch',
          message: 'Production branch is empty.',
        });
      }
    }

    const hasAnyAutoStage =
      pipeline.state?.enabled === true &&
      STAGE_NAMES.some((stage) => {
        const sc = pipeline.state.states[stage];
        return sc?.enabled !== false && (sc?.mode ?? 'auto') === 'auto';
      });

    if (hasAnyAutoStage) {
      if (!cfg?.chatProviderId || cfg.chatProviderId.trim().length === 0) {
        issues.push({
          section: 'agent.providers',
          field: 'providers.chatProviderId',
          message: 'Chat provider is empty while auto-mode stages are enabled.',
        });
      }
      if (!cfg?.chatModel || cfg.chatModel.trim().length === 0) {
        issues.push({
          section: 'agent.providers',
          field: 'providers.chatModel',
          message: 'Chat model is empty while auto-mode stages are enabled.',
        });
      }
    }

    if (pipeline.state?.enabled === true) {
      const anyStageEnabled = STAGE_NAMES.some((stage) => {
        const sc = pipeline.state.states[stage];
        return sc?.enabled !== false;
      });
      if (!anyStageEnabled) {
        issues.push({
          section: 'pipeline.config',
          field: 'pipeline.enabled',
          message: 'Pipeline is enabled but no states are active.',
        });
      }
    }

    const registeredStages = new Set(
      (registrations.data?.registrations ?? []).map((r) => r.stage),
    );

    if (pipeline.state?.enabled === true) {
      for (const stage of STAGE_NAMES) {
        const sc = pipeline.state.states[stage];
        if (sc?.enabled === false) continue;
        if ((sc?.mode ?? 'auto') !== 'auto') continue;
        if (registeredStages.has(stage)) continue;
        if (stage === 'open' || stage === 'tested' || stage === 'pass' || stage === 'staging' || stage === 'deploying') {
          // Soft-skip or terminal stages don't require a skill.
          continue;
        }
        issues.push({
          section: 'pipeline.skills',
          field: `skills.${stage}`,
          message: `Stage ${stage} is in auto mode but no skill is registered.`,
        });
      }
    }

    return {
      status: issues.length === 0 ? 'ok' : 'warn',
      issues,
    };
  }, [project.data, appConfig.data, pipeline.state, registrations.data]);
}
