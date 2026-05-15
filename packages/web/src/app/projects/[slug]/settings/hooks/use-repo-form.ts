'use client';

import { useEffect, useMemo, useState } from 'react';
import { useProject, useUpdateProject } from '@/features/project/hooks/use-projects';

export interface RepoFormState {
  repoPath: string;
  baseBranch: string;
  productionBranch: string;
}

const EMPTY: RepoFormState = { repoPath: '', baseBranch: '', productionBranch: '' };

function nullableString(v: string): string | null {
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function useRepoForm(projectId: string | undefined) {
  const projectQuery = useProject(projectId);
  const updateProject = useUpdateProject();

  const initial = useMemo<RepoFormState>(() => {
    const p = projectQuery.data;
    return {
      repoPath: p?.repoPath ?? '',
      baseBranch: p?.baseBranch ?? '',
      productionBranch: p?.productionBranch ?? '',
    };
  }, [projectQuery.data]);

  const [state, setState] = useState<RepoFormState>(EMPTY);

  useEffect(() => {
    setState(initial);
  }, [initial]);

  const setField = <K extends keyof RepoFormState>(key: K, value: RepoFormState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
    if (updateProject.isSuccess || updateProject.isError) updateProject.reset();
  };

  const isDirty =
    state.repoPath !== initial.repoPath ||
    state.baseBranch !== initial.baseBranch ||
    state.productionBranch !== initial.productionBranch;

  async function save() {
    if (!projectId) return;
    const patch: Record<string, unknown> = {};
    if (state.repoPath !== initial.repoPath) patch.repoPath = nullableString(state.repoPath);
    if (state.baseBranch !== initial.baseBranch) patch.baseBranch = nullableString(state.baseBranch);
    if (state.productionBranch !== initial.productionBranch)
      patch.productionBranch = nullableString(state.productionBranch);
    if (Object.keys(patch).length === 0) return;
    await updateProject.mutateAsync({ id: projectId, patch });
  }

  function reset() {
    setState(initial);
    if (updateProject.isSuccess || updateProject.isError) updateProject.reset();
  }

  return {
    state,
    setField,
    isDirty,
    isSubmitting: updateProject.isPending,
    isError: updateProject.isError,
    isSuccess: updateProject.isSuccess && !isDirty,
    save,
    reset,
  };
}
