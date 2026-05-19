'use client';

import { useMemo } from 'react';
import { useMyDevices } from '@/features/device/hooks/use-devices';
import { useIssues } from '@/features/issue/hooks/use-issues';
import { usePipelineConfig } from '@/features/pipeline/config/hooks/use-pipeline-config';
import { useProjectPipelineRuns } from '@/features/pipeline-run/hooks/use-pipeline-runs';
import { useProject } from '@/features/project/hooks/use-projects';
import { useProjectSkillRegistrations } from '@/features/skill/hooks/use-skills';
import type { ProjectSetupBooleans } from '../types';

/**
 * Derives the eight onboarding-checklist booleans for a project from the
 * existing React Query data sources. Each boolean is `null` while the
 * underlying query is loading — callers render an indeterminate state in
 * that case rather than a misleading green check.
 *
 * This hook fires several queries unconditionally. The dashboard already
 * mounts most of them, so the marginal cost is one extra issues fetch +
 * one extra pipeline-runs fetch per render.
 */
export function useProjectSetupState(projectId: string | undefined): ProjectSetupBooleans {
  const projectQ = useProject(projectId);
  const pipelineCfg = usePipelineConfig(projectId);
  const skillsQ = useProjectSkillRegistrations(projectId);
  const devicesQ = useMyDevices();
  const issuesQ = useIssues({ projectId: projectId ?? '', limit: 1 });
  const runsQ = useProjectPipelineRuns({ projectId: projectId ?? '', limit: 50 });

  return useMemo<ProjectSetupBooleans>(() => {
    const project = projectQ.data;
    const repo = project ? Boolean(project.repoPath) : null;
    const branches = project
      ? Boolean(project.baseBranch) && Boolean(project.productionBranch)
      : null;
    const members = project ? project.members.length > 1 : null;
    const devices = project ? project.devicePool.length > 0 : null;
    // `usePipelineConfig` swallows the loading state into `state.enabled = false`
    // when `isLoading`; use the isLoading flag to fork null.
    const pipeline = pipelineCfg.isLoading ? null : pipelineCfg.state.enabled === true;
    const skills = skillsQ.isLoading
      ? null
      : (skillsQ.data?.registrations.length ?? 0) > 0;
    const firstIssue = issuesQ.isLoading ? null : (issuesQ.data?.totalCount ?? 0) > 0;
    const firstRun = runsQ.isLoading
      ? null
      : (runsQ.data?.items ?? []).some((r) => r.status === 'completed');
    // Unused devicesQ — referenced so the dashboard's other devices badge
    // shares the cache. The `devices` boolean above comes from devicePool,
    // not myDevices.
    void devicesQ;
    return { repo, branches, members, pipeline, skills, devices, firstIssue, firstRun };
  }, [projectQ.data, pipelineCfg.isLoading, pipelineCfg.state.enabled, skillsQ.isLoading, skillsQ.data, devicesQ, issuesQ.isLoading, issuesQ.data, runsQ.isLoading, runsQ.data]);
}
