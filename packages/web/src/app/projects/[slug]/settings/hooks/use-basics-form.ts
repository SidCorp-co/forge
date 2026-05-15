'use client';

import { useEffect, useMemo, useState } from 'react';
import { useProject, useUpdateProject } from '@/features/project/hooks/use-projects';

export interface BasicsFormState {
  name: string;
  description: string;
}

const EMPTY: BasicsFormState = { name: '', description: '' };

function nullableString(v: string): string | null {
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function useBasicsForm(projectId: string | undefined) {
  const projectQuery = useProject(projectId);
  const updateProject = useUpdateProject();

  const initial = useMemo<BasicsFormState>(() => {
    const p = projectQuery.data;
    return {
      name: p?.name ?? '',
      description: p?.description ?? '',
    };
  }, [projectQuery.data]);

  const [state, setState] = useState<BasicsFormState>(EMPTY);

  useEffect(() => {
    setState(initial);
  }, [initial]);

  const setField = <K extends keyof BasicsFormState>(key: K, value: BasicsFormState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
    if (updateProject.isSuccess || updateProject.isError) updateProject.reset();
  };

  const isDirty = state.name !== initial.name || state.description !== initial.description;

  async function save() {
    if (!projectId) return;
    const patch: Record<string, unknown> = {};
    if (state.name !== initial.name) patch.name = state.name.trim();
    if (state.description !== initial.description) patch.description = nullableString(state.description);
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
